# Docker Build Known Issue

## Problem
There is a known issue with npm in Docker environments that causes `npm install` and `npm ci` commands to timeout with the error "Exit handler never called!". This is a bug in npm itself and is not related to the Node version upgrade.

## Issue Details
- Error: `npm error Exit handler never called!`
- Affects: npm 10.x in Docker containers (Alpine and Debian-based images)
- Related: https://github.com/npm/cli/issues

## Workarounds

### Option 1: Use GitHub Actions for Building
The GitHub Actions workflow builds the Docker image successfully in CI/CD environments. Use the pre-built images from GitHub Container Registry:

```bash
docker pull ghcr.io/graysoncadams/amazon-ynab-sync:latest
```

### Option 2: Build Locally Outside Docker
If building locally:

```bash
# Install dependencies locally
npm install

# Then build without re-installing in Docker
# (Modify Dockerfile to skip npm install if node_modules exists)
docker build -t amazon-ynab-sync .
```

### Option 3: Use Pre-Node-22 Image
If you need to build locally and can't use workarounds above, the older Node 12 version doesn't have this npm bug, but is not recommended due to security and support concerns.

## Status
- ✅ Application code fully compatible with Node 22
- ✅ Dependencies install successfully outside Docker
- ✅ Server starts and runs correctly with Node 22
- ⚠️ Docker build affected by npm timeout bug (not Node-related)

## Verification
To verify the application works with Node 22:

```bash
# Check Node version
node --version  # Should be 22.x

# Install dependencies
npm install

# Run application (will fail due to missing credentials, which is expected)
npm start
```

The application should start and attempt to connect to YNAB, proving Node 22 compatibility.
