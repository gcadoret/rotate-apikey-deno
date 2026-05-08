# Gemini API Key Rotator

This project is a Deno proxy designed to sit in front of the Google Gemini API. Its main purpose is to manage a pool of API keys and automatically rotate between them. If a request fails because of a quota limit (429 error), the proxy transparently retries with the next available API key.

## Features

- **API Key Rotation**: Uses a list of API keys provided through an environment variable.
- **Quota Handling**: Detects quota errors (`401`, `403`, `429`) and automatically switches to another key.
- **Temporary Cooldown**: If a key is marked as exhausted, it is set aside for one hour before being reused.
- **Security**: Optionally protect proxy access with an access token (`ACCESS_TOKEN`).
- **Easy Deployment**: Ready to deploy with Docker and Docker Compose.

## Requirements

- [Docker](https://www.docker.com/get-started)
- [Docker Compose](https://docs.docker.com/compose/install/) (usually included with Docker Desktop)

## Quick Start

1.  **Clone the project** (if you have not already done so).

2.  **Configure your API keys**:
    Open `docker-compose.yml` and replace the keys in the `API_KEYS` environment variable with your own. Keys must be separated by commas.

    ```yaml
    services:
      gemini-proxy:
        build: .
        container_name: gemini-proxy
        environment:
          - API_KEYS="YOUR_KEY_1,YOUR_KEY_2,YOUR_KEY_3"
          # - ACCESS_TOKEN=your_secret_token # Uncomment to enable access control
        ports:
          - "8000:8000"
        restart: unless-stopped
    ```

3.  **Start the service**:
    From the project root, run:
    ```bash
    docker-compose up -d
    ```

The proxy will now be available at `http://localhost:8000`.

## Usage

To use the proxy, send your Gemini API calls to your local instance instead of Google's direct URL.

For example, if you previously called `https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY`, you now call:

`http://localhost:8000/v1beta/models`

The proxy automatically adds the `?key=` parameter with a valid key from your pool.

### With an Access Token (Optional)

If you configured an `ACCESS_TOKEN` in `docker-compose.yml`, include it in the `X-Access-Token` header for every request:

```bash
curl http://localhost:8000/v1beta/models \
  -H "X-Access-Token: your_secret_token"
```

## Environment Variables

- `API_KEYS` (required): A string containing your API keys, separated by commas.
- `ACCESS_TOKEN` (optional): A secret token that must be provided in the `X-Access-Token` header to authorize requests.
- `GEMINI_API_BASE_URL` (optional): The Gemini API base URL. Defaults to `https://generativelanguage.googleapis.com/v1beta2`.
