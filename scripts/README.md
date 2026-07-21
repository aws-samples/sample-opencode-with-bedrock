# Deployment Scripts

This directory contains deployment scripts for the OpenCode Stack.

## deploy.sh

Main deployment script that orchestrates the deployment of all stacks in the correct order.

### Usage

```bash
# Deploy all stacks
./scripts/deploy.sh

# Deploy individual stages
./scripts/deploy.sh network       # Network + Certificate
./scripts/deploy.sh auth          # Auth (OIDC config + auto-create ALB secret)
./scripts/deploy.sh api           # API (ECS + JWT ALB)
./scripts/deploy.sh distribution  # Distribution (Landing page + OIDC ALB)

# Deploy share feature (optional)
./scripts/deploy.sh share         # Share feature (S3, DynamoDB, WebSocket, Lambdas)

# Validate without deploying
./scripts/deploy.sh preflight

# Deploy to specific environment
./scripts/deploy.sh -e prod all
ENVIRONMENT=staging ./scripts/deploy.sh

# Deploy with IdP federation (provision inputs into AWS once, then deploy)
./scripts/bootstrap-idp.sh <env> <client-id> <provider-name> <issuer-url> <client-secret>
./scripts/deploy.sh

# Build and push router image only
./scripts/deploy.sh build-image

# Force ECS service redeployment
./scripts/deploy.sh redeploy

# Show deployment information
./scripts/deploy.sh info
```

### Deployment Stages

1. **network** - Network + Certificate
   - NetworkStack: VPC, subnets, NAT Gateway
   - SharedCertificateStack: ACM certificate for all ALBs

2. **auth** - OIDC Authentication
   - AuthStack: Cognito or external OIDC provider
   - Auto-creates ALB client secret in Secrets Manager (Cognito mode)

3. **api** - API Infrastructure
   - ApiStack: Target group, JWT ALB with HTTPS listener, ECS Fargate router service

4. **distribution** - Landing Page + Browser Auth
   - DistributionStack: S3 bucket, Lambda function, OIDC ALB for browser auth

5. **share** *(optional)* - Session Sharing
   - ShareStack: S3 storage, DynamoDB connections table, WebSocket API Gateway, Lambda functions, ALB listener rules
   - Enabled with `-c enableShareFeature=true` or `./scripts/deploy.sh share`

### Environment Variables

- `ENVIRONMENT` - Environment name (default: dev)
- `AWS_REGION` - AWS region (default: us-east-1)
- `AWS_PROFILE` - AWS profile to use
- `CONTAINER_BUILDER` - Container tool to use: `docker` (default) or `finch`

> **IdP federation:** IdP inputs (client ID, provider name, issuer, client secret) are
> no longer passed via `IDP_CLIENT_ID`/`IDP_CLIENT_SECRET` env vars. They are provisioned
> into AWS (SSM Parameter Store + Secrets Manager) via `scripts/bootstrap-idp.sh` and read
> by the AuthStack at deploy time. See `docs/IDP-FEDERATION.md`.

### Prerequisites

- AWS CLI configured with appropriate credentials
- AWS CDK installed (`npm install -g aws-cdk`)
- Docker or Finch (for building router container image)
- Node.js 18+

### AWS Credentials

This project requires AWS credentials with appropriate permissions:

```bash
# Option 1: AWS SSO (recommended)
aws configure sso
aws sso login --profile your-profile
export AWS_PROFILE=your-profile

# Option 2: Environment variables
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_REGION=us-east-1

# Option 3: IAM role (automatic on EC2/ECS/Lambda)
```

### Container Builder

This project uses [Docker](https://docs.docker.com/get-docker/) as the default container builder. [Finch](https://github.com/runfinch/finch) is also supported as an alternative.

**Using Finch instead:**
If you prefer to use Finch, set the environment variable:
```bash
export CONTAINER_BUILDER=finch
./scripts/deploy.sh
```

### What the Script Does

1. Checks prerequisites (AWS CLI, CDK, Docker/Finch)
2. Builds the CDK project
3. Bootstraps CDK if needed
4. Deploys stacks in order:
   - Network: VPC + Certificate
   - Auth: OIDC configuration + auto-creates ALB client secret in Secrets Manager
   - API: ECS Fargate service + JWT ALB
   - Builds and pushes container image (using Docker or Finch)
   - Forces ECS redeployment to pick up new image
   - Distribution: Landing page Lambda + OIDC ALB
5. Prints deployment information

### Error Handling

The script stops on first error (`set -e`). Each phase must complete successfully before the next phase begins.

### Manual Deployment

If you prefer to deploy manually using CDK:

```bash
# Build CDK
npm run build

# Deploy individual stacks in order
cdk deploy OpenCodeNetwork-dev
cdk deploy OpenCodeCertificate-dev
cdk deploy OpenCodeAuth-dev

# Deploy API Stack (includes Target Group, JWT ALB, and ECS Service)
cdk deploy OpenCodeApi-dev

# Build and push router image (see Manual Container Image Build section)

# Deploy Distribution Stack (includes Lambda, S3, and OIDC ALB)
cdk deploy OpenCodeDistribution-dev

# Deploy Share Stack (optional — requires enableShareFeature context flag)
# First build Lambda code:
cd services/share/lambda && npm install && npm run build && npm prune --omit=dev && cd ../../..
cd services/share/websocket && npm install && npm run build && npm prune --omit=dev && cd ../../..
cdk deploy OpenCodeShare-dev -c enableShareFeature=true
```

**Note:** The ApiStack and DistributionStack are consolidated stacks that create multiple resources. Do not attempt to deploy TargetGroup, JwtAlb, Router, or OidcAlb stacks separately - they have been merged into ApiStack and DistributionStack.

### Manual Container Image Build

If you need to build and push the router image manually:

**Using Docker:**
```bash
cd services/router
docker build -t bedrock-router .
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker tag bedrock-router:latest <ecr-uri>:latest
docker push <ecr-uri>:latest
```

**Using Finch:**
```bash
cd services/router
finch build -t bedrock-router .
aws ecr get-login-password --region us-east-1 | finch login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
finch tag bedrock-router:latest <ecr-uri>:latest
finch push <ecr-uri>:latest
```

## bootstrap-idp.sh

Provisions external IdP (OIDC federation) inputs into AWS for an environment. Writes the
non-secret config (client ID, provider name, issuer) to SSM Parameter Store and the client
secret to Secrets Manager. Run once per environment (and again to update values); the
AuthStack reads these at deploy time — no env vars or `-c` flags required. See
`docs/IDP-FEDERATION.md`.

### Usage

```bash
./scripts/bootstrap-idp.sh <env> <client-id> <provider-name> <issuer-url> <client-secret>
```
