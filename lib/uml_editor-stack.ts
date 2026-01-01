import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigatewayv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class UmlEditorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Cognito User Pool for Authentication
    const userPool = new cognito.UserPool(this, 'DiagramUserPool', {
      userPoolName: 'diagram-users',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
        username: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev - use RETAIN in production
    });

    // Import existing Cognito Domain (created manually in console)
    const userPoolDomain = cognito.UserPoolDomain.fromDomainName(
      this,
      'DiagramUserPoolDomain',
      'umleditor'
    );

    // Cognito User Pool Client for API access
    const userPoolClient = new cognito.UserPoolClient(this, 'DiagramUserPoolClient', {
      userPool,
      userPoolClientName: 'diagram-api-client',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false, // Web/mobile apps should not use client secret
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.COGNITO_ADMIN,
        ],
        callbackUrls: [
          'http://localhost:3000',
          'http://localhost:3000/callback',
        ],
        logoutUrls: [
          'http://localhost:3000',
        ],
      },
    });

    // VPC for ECS Fargate
    const vpc = new ec2.Vpc(this, 'DiagramVpc', {
      maxAzs: 2,
      natGateways: 1, // Cost optimization - use 1 NAT Gateway
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // DynamoDB Table - Single Table Design
    const diagramsTable = new dynamodb.Table(this, 'DiagramsTable', {
      tableName: 'Diagrams',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev - use RETAIN in production
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // S3 Bucket for Diagram Storage
    const diagramsBucket = new s3.Bucket(this, 'DiagramsBucket', {
      bucketName: `diagrams-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev - use RETAIN in production
      autoDeleteObjects: true, // For dev - remove in production
      versioned: true,
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    // ECR Repository for D2 Renderer Docker Image
    const d2RendererRepo = new ecr.Repository(this, 'D2RendererRepo', {
      repositoryName: 'd2-renderer',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      imageScanOnPush: true,
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'D2RendererCluster', {
      vpc,
      clusterName: 'd2-renderer-cluster',
      containerInsights: true,
    });

    // ECS Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'D2RendererTask', {
      cpu: 256, // 0.25 vCPU
      memoryLimitMiB: 512, // 0.5 GB
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Grant S3 write permissions to task role
    diagramsBucket.grantReadWrite(taskDefinition.taskRole);

    // Container Definition
    const container = taskDefinition.addContainer('D2RendererContainer', {
      image: ecs.ContainerImage.fromEcrRepository(d2RendererRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'd2-renderer',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        S3_BUCKET: diagramsBucket.bucketName,
        PORT: '3000',
        MAX_INPUT_SIZE: '100000',
      },
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "require(\'http\').get(\'http://localhost:3000/health\', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // Security Group for ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Security group for internal ALB',
      allowAllOutbound: true,
    });

    // Security Group for ECS Service
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      description: 'Security group for D2 renderer ECS service',
      allowAllOutbound: true,
    });

    // Allow ALB to communicate with ECS
    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      'Allow traffic from ALB'
    );

    // Internal Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'D2RendererAlb', {
      vpc,
      internetFacing: false,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'D2RendererTargetGroup', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ALB Listener
    const listener = alb.addListener('D2RendererListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // ECS Fargate Service
    const service = new ecs.FargateService(this, 'D2RendererService', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      securityGroups: [ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      enableExecuteCommand: true, // For debugging
    });

    // Attach service to target group
    service.attachToApplicationTargetGroup(targetGroup);

    // Auto Scaling
    const scaling = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 5,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Lambda Function for API
    const apiLambda = new lambda.Function(this, 'ApiLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 1024,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [ecsSecurityGroup], // Allow Lambda to call ALB
      environment: {
        DYNAMODB_TABLE: diagramsTable.tableName,
        S3_BUCKET: diagramsBucket.bucketName,
        D2_SERVICE_URL: `http://${alb.loadBalancerDnsName}`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Grant permissions to Lambda
    diagramsTable.grantReadWriteData(apiLambda);
    diagramsBucket.grantReadWrite(apiLambda);

    // HTTP API Gateway
    const httpApi = new apigatewayv2.HttpApi(this, 'DiagramHttpApi', {
      apiName: 'diagram-api',
      description: 'Diagram rendering API',
      corsPreflight: {
        allowOrigins: ['*'], // Configure appropriately for production
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['*'],
        maxAge: cdk.Duration.days(1),
      },
    });

    // Lambda Integration
    const lambdaIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LambdaIntegration',
      apiLambda
    );

    // JWT Authorizer with Cognito
    const authorizer = new apigatewayv2Authorizers.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      }
    );

    // API Routes
    httpApi.addRoutes({
      path: '/diagrams',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lambdaIntegration,
      authorizer,
    });

    httpApi.addRoutes({
      path: '/diagrams',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
      authorizer,
    });

    httpApi.addRoutes({
      path: '/diagrams/{diagramId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
      authorizer,
    });

    httpApi.addRoutes({
      path: '/diagrams/{diagramId}',
      methods: [apigatewayv2.HttpMethod.DELETE],
      integration: lambdaIntegration,
      authorizer,
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'HTTP API Gateway URL',
    });

    new cdk.CfnOutput(this, 'CognitoHostedUIUrl', {
      value: `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com/login?client_id=${userPoolClient.userPoolClientId}&response_type=code&redirect_uri=http://localhost:3000/callback`,
      description: 'Cognito Hosted UI Login URL',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'DynamoDBTable', {
      value: diagramsTable.tableName,
      description: 'DynamoDB Table Name',
    });

    new cdk.CfnOutput(this, 'S3Bucket', {
      value: diagramsBucket.bucketName,
      description: 'S3 Bucket Name',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: d2RendererRepo.repositoryUri,
      description: 'ECR Repository URI for D2 Renderer',
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'Internal ALB DNS Name',
    });

    new cdk.CfnOutput(this, 'D2ServiceUrl', {
      value: `http://${alb.loadBalancerDnsName}`,
      description: 'D2 Rendering Service URL',
    });
  }
}
