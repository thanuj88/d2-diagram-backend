#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UmlEditorStack } from '../lib/uml_editor-stack';

const app = new cdk.App();

// Deploy using personal2 AWS profile
// Configure OIDC settings if you have an identity provider
new UmlEditorStack(app, 'UmlEditorStack', {
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  },
  
  // Optional: Configure JWT authentication
  // Uncomment and set these values if you have an OIDC provider
  // oidcIssuerUrl: 'https://your-idp.com',
  // oidcAudience: 'your-client-id',
  
  description: 'Diagram rendering platform with D2, API Gateway, Lambda, DynamoDB, S3, and ECS Fargate',
  
  tags: {
    Project: 'DiagramRenderer',
    Environment: 'Development',
    ManagedBy: 'CDK',
  },
});
