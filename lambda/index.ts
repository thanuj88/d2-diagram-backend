import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import * as http from 'http';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE!;
const S3_BUCKET = process.env.S3_BUCKET!;
const D2_SERVICE_URL = process.env.D2_SERVICE_URL!;

interface CreateDiagramRequest {
  d2Text: string;
  diagramType: 'architecture' | 'sequence' | 'flow';
  format?: 'svg' | 'png';
  metadata?: Record<string, unknown>;
}

/**
 * Extract userId from JWT token (from authorizer context)
 */
function getUserId(event: APIGatewayProxyEventV2): string {
  // When using JWT authorizer, the claims are available in requestContext.authorizer.jwt.claims
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authorizer = (event.requestContext as any)?.authorizer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const claims = authorizer?.jwt?.claims as any;
  
  if (!claims || !claims.sub) {
    throw new Error('Unauthorized: No valid user identity found');
  }
  
  return claims.sub as string;
}

/**
 * Call D2 rendering service (ECS Fargate)
 */
async function callD2Service(d2Text: string, format: string, userId: string, diagramId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      d2Text,
      format,
      userId,
      diagramId,
    });

    const url = new URL('/render', D2_SERVICE_URL);
    
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 25000, // 25 second timeout
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const response = JSON.parse(data);
            if (response.success && response.s3Key) {
              console.log(`D2 rendering successful: ${response.s3Key}`);
              resolve(response.s3Key);
            } else {
              reject(new Error('D2 service returned invalid response'));
            }
          } catch (error) {
            reject(new Error('Failed to parse D2 service response'));
          }
        } else {
          reject(new Error(`D2 service returned status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error('Error calling D2 service:', error);
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('D2 service request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Render D2 diagram using ECS service
 */
async function renderD2Diagram(d2Text: string, format: string, userId: string, diagramId: string): Promise<string> {
  try {
    // Call the D2 rendering service
    const s3Key = await callD2Service(d2Text, format, userId, diagramId);
    return s3Key;
  } catch (error) {
    console.error('Failed to render D2 diagram:', error);
    
    // Extract D2 syntax error if available
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('D2 service returned status 500')) {
      try {
        // Try to parse the error response to get D2 syntax errors
        const match = errorMessage.match(/"message":"([^"]+)"/);
        if (match) {
          const d2Error = match[1].replace(/\\n/g, '\n');
          throw new Error(`D2 Syntax Error:\n${d2Error}`);
        }
      } catch (parseError) {
        // Fall through to generic error
      }
    }
    
    throw new Error('Diagram rendering failed. Please check your D2 syntax and try again.');
  }
}

/**
 * Generate signed URL for S3 object
 */
async function generateSignedUrl(s3Key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
  });

  return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

/**
 * Fetch SVG content from S3
 */
async function fetchSvgFromS3(s3Key: string): Promise<string> {
  try {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    });

    const response = await s3Client.send(command);
    
    if (!response.Body) {
      throw new Error('Empty response from S3');
    }

    // Convert stream to string
    const svgContent = await response.Body.transformToString();
    return svgContent;
  } catch (error) {
    console.error('Error fetching SVG from S3:', error);
    throw new Error('Failed to fetch diagram content from S3');
  }
}

/**
 * POST /diagrams - Create new diagram
 */
async function createDiagram(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing request body' }),
      };
    }

    const body: CreateDiagramRequest = JSON.parse(event.body);
    
    if (!body.d2Text || !body.diagramType) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields: d2Text, diagramType' }),
      };
    }

    console.log(`Creating diagram for user: ${userId}, type: ${body.diagramType}`);

    // Generate diagram ID
    const createdAt = new Date().toISOString();
    const diagramId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Render D2 diagram
    const startTime = Date.now();
    const s3Key = await renderD2Diagram(body.d2Text, body.format || 'svg', userId, diagramId);
    const renderDuration = Date.now() - startTime;
    
    console.log(`D2 rendering completed in ${renderDuration}ms, S3 key: ${s3Key}`);

    // Store metadata in DynamoDB
    const item = {
      PK: `USER#${userId}`,
      SK: `DIAGRAM#${createdAt}#${diagramId}`,
      diagramId,
      diagramType: body.diagramType,
      createdAt,
      s3Key,
      metadata: body.metadata || {},
    };

    await docClient.send(new PutCommand({
      TableName: DYNAMODB_TABLE,
      Item: item,
    }));

    // Generate signed URL
    const signedUrl = await generateSignedUrl(s3Key);
    
    // Fetch SVG content from S3
    const svgContent = await fetchSvgFromS3(s3Key);

    return {
      statusCode: 201,
      body: JSON.stringify({
        diagramId,
        diagramType: body.diagramType,
        createdAt,
        s3Url: signedUrl,
        svgContent,
        renderDuration,
      }),
    };
  } catch (error) {
    console.error('Error creating diagram:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to create diagram',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}

/**
 * GET /diagrams - List diagrams for authenticated user
 */
async function listDiagrams(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    
    console.log(`Listing diagrams for user: ${userId}`);

    const result = await docClient.send(new QueryCommand({
      TableName: DYNAMODB_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
      },
      ScanIndexForward: false, // Most recent first
    }));

    const diagrams = await Promise.all(
      (result.Items || []).map(async (item) => {
        const signedUrl = await generateSignedUrl(item.s3Key);
        const svgContent = await fetchSvgFromS3(item.s3Key);
        return {
          diagramId: item.diagramId,
          diagramType: item.diagramType,
          createdAt: item.createdAt,
          s3Url: signedUrl,
          svgContent,
          metadata: item.metadata,
        };
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ diagrams }),
    };
  } catch (error) {
    console.error('Error listing diagrams:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to list diagrams',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}

/**
 * GET /diagrams/{diagramId} - Get a specific diagram
 */
async function getDiagram(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const diagramId = event.pathParameters?.diagramId;
    
    if (!diagramId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing diagramId' }),
      };
    }

    console.log(`Getting diagram ${diagramId} for user: ${userId}`);

    // Query to find the diagram
    const queryResult = await docClient.send(new QueryCommand({
      TableName: DYNAMODB_TABLE,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: 'diagramId = :diagramId',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
        ':diagramId': diagramId,
      },
    }));

    if (!queryResult.Items || queryResult.Items.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Diagram not found' }),
      };
    }

    const item = queryResult.Items[0];
    const signedUrl = await generateSignedUrl(item.s3Key);
    const svgContent = await fetchSvgFromS3(item.s3Key);

    return {
      statusCode: 200,
      body: JSON.stringify({
        diagramId: item.diagramId,
        diagramType: item.diagramType,
        createdAt: item.createdAt,
        s3Url: signedUrl,
        svgContent,
        metadata: item.metadata,
      }),
    };
  } catch (error) {
    console.error('Error getting diagram:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to get diagram',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}

/**
 * DELETE /diagrams/{diagramId} - Delete diagram
 */
async function deleteDiagram(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const diagramId = event.pathParameters?.diagramId;
    
    if (!diagramId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing diagramId' }),
      };
    }

    console.log(`Deleting diagram ${diagramId} for user: ${userId}`);

    // Query to find the diagram
    const queryResult = await docClient.send(new QueryCommand({
      TableName: DYNAMODB_TABLE,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: 'diagramId = :diagramId',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
        ':diagramId': diagramId,
      },
    }));

    if (!queryResult.Items || queryResult.Items.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Diagram not found' }),
      };
    }

    const item = queryResult.Items[0];

    // Delete from S3
    await s3Client.send(new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: item.s3Key,
    }));

    // Delete from DynamoDB
    await docClient.send(new DeleteCommand({
      TableName: DYNAMODB_TABLE,
      Key: {
        PK: item.PK,
        SK: item.SK,
      },
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Diagram deleted successfully' }),
    };
  } catch (error) {
    console.error('Error deleting diagram:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to delete diagram',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}

/**
 * Main Lambda handler
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  console.log('Event:', JSON.stringify(event, null, 2));

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  try {
    if (method === 'POST' && path === '/diagrams') {
      return await createDiagram(event);
    } else if (method === 'GET' && path === '/diagrams') {
      return await listDiagrams(event);
    } else if (method === 'GET' && path.startsWith('/diagrams/')) {
      return await getDiagram(event);
    } else if (method === 'DELETE' && path.startsWith('/diagrams/')) {
      return await deleteDiagram(event);
    } else {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Not found' }),
      };
    }
  } catch (error) {
    console.error('Unhandled error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
