
# UML Editor

## Overview
This project is a comprehensive UML Editor designed to facilitate the creation, editing, and management of UML diagrams. It leverages modern cloud-native technologies and best practices for scalability, security, and maintainability.

## Architecture Summary
- **Frontend**: Web-based interface for drawing and editing UML diagrams.
- **Backend**: Serverless Lambda functions for processing, storage, and authentication.
- **Rendering**: Dedicated D2-based renderer for diagram generation.
- **Authentication**: AWS Cognito for secure user management.
- **Infrastructure**: Provisioned using AWS CDK (Cloud Development Kit).

## Key Components
- **bin/**: Entry point scripts for the application.
- **lib/**: CDK stack definitions and infrastructure code.
- **lambda/**: Source code for AWS Lambda functions (API, processing, etc.).
- **d2-renderer/**: Service for rendering diagrams using D2.
- **test/**: Automated tests for the application.

## Deployment
- Infrastructure and application deployment is automated via CDK and PowerShell scripts (`deploy.ps1`, `setup-deployment.ps1`).
- The D2 renderer can be containerized using the provided Dockerfile in `d2-renderer/`.

## Security
- User authentication and authorization are managed by AWS Cognito.
- Follows best practices for secure storage and access control.

## Getting Started
1. **Install dependencies**:
	```sh
	npm install
	```
2. **Bootstrap AWS CDK** (if not already done):
	```sh
	cdk bootstrap
	```
3. **Deploy the stack**:
	```sh
	cdk deploy
	```
4. **Run the D2 renderer locally** (optional):
	```sh
	cd d2-renderer
	docker build -t d2-renderer .
	docker run -p 8080:8080 d2-renderer
	```

## Project Structure
- `bin/uml_editor.ts`: CDK app entry point
- `lib/uml_editor-stack.ts`: Main infrastructure stack
- `lambda/`: Lambda function code
- `d2-renderer/`: Diagram rendering service
- `test/`: Tests

## Documentation
- See `COMPLETE_ARCHITECTURE_GUIDE.md` for a detailed architecture walkthrough.
- See `DEPLOYMENT.md` and `D2-DEPLOYMENT-GUIDE.md` for deployment instructions.
- See `cognito-auth-example.md` for authentication setup.

## Contributing
Contributions are welcome! Please open issues and submit pull requests for improvements or bug fixes.

## License
[Specify your license here]
