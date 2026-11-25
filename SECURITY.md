# Security policy

ProductOps is a **local portfolio prototype**. It is not deployed, holds no real data, and is not intended for production use.

## Reporting

If you find a vulnerability or an accidentally committed secret, please open a GitHub issue that avoids exploit details, or contact the repository owner via their GitHub profile.

## Scope and honest limits

- All data is synthetic. Credentials are supplied locally through `.env.local` (git-ignored); CI generates ephemeral masked credentials.
- **F1 (reduced):** auth and API run as separate processes with separate DB roles and key custody, but the API login proxy sees plaintext credentials and tokens, and both processes run under one OS user.
- **F2 (open):** the API role can assert tenant and actor database settings, so row-level security and four-eyes approval are not trustworthy after API compromise.
- No real LLM is integrated. Rule coverage is finite and says nothing about a future model.
- Rate limits are in-memory and per process. No retention, backup, monitoring or deployment design has been validated. No penetration test has been performed.

See [Security model](docs/portfolio/SECURITY_MODEL.md) for the full threat table.
