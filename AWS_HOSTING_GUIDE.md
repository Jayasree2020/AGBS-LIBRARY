# AWS Hosting Guide For AGBS LIBRARY

This guide records the current production AWS setup for AGBS LIBRARY.

## Current Production Setup

```text
GitHub repository
        |
        v
Elastic Beanstalk application version ZIP
        |
        v
AWS Elastic Beanstalk
        |
        v
AWS S3 bucket
  - agbs-library/books/
  - agbs-library/data/
  - agbs-library/tmp/
```

Production hosting is now AWS Elastic Beanstalk. Vercel is no longer the production host.

## Live URLs

Production HTTPS is active:

- `https://www.agbslibrary.com`
- `http://www.agbslibrary.com`
- `http://Agbs-library-aws-1-env.eba-8uziqsiu.us-east-1.elasticbeanstalk.com`

The root domain `agbslibrary.com` requires DNS root alias/CNAME support or Route 53 if it must resolve without `www`.

## GitHub Rule

All code changes must be pushed to:

```text
https://github.com/Jayasree2020/AGBS-LIBRARY
```

Do not edit production files manually in AWS. Make changes in this repository, create a new Elastic Beanstalk application version ZIP, then deploy that version.

## Automatic GitHub Deployment

GitHub Actions deploys `main` to Elastic Beanstalk automatically.

Workflow file:

```text
.github/workflows/deploy-elastic-beanstalk.yml
```

Deployment role:

```text
arn:aws:iam::567681717467:role/agbs-github-elasticbeanstalk-deploy
```

The workflow uses GitHub OIDC to assume the AWS role, builds a clean source ZIP, uploads it to the Elastic Beanstalk S3 artifact bucket, creates an application version, and updates:

```text
Application: agbs-library
Environment: Agbs-library-aws-1-env
Region: us-east-1
```

After this workflow is active, normal changes should follow this path:

```text
local code change -> GitHub main -> GitHub Actions -> Elastic Beanstalk
```

## Files Used By AWS

- `server.js`: Node.js application server.
- `public/`: browser app, styles, and assets.
- `api/`: compatibility entrypoint files.
- `package.json` and `package-lock.json`: Node dependencies.
- `Procfile`: tells Elastic Beanstalk to run `npm start`.
- `Dockerfile` and `.dockerignore`: retained for a future container-based AWS deployment if needed.

## Elastic Beanstalk Settings

Current environment:

```text
Application: agbs-library
Environment: Agbs-library-aws-1-env
Platform: Node.js 22 running on 64bit Amazon Linux 2023
Environment type: Load balanced
Proxy: nginx
App port: 8080
```

The load-balanced setup is required for AWS-only HTTPS. The load balancer has HTTP port `80` and HTTPS port `443` listeners, with the ACM certificate attached to the HTTPS listener.

## Required Environment Variables

Set these in Elastic Beanstalk environment properties, not in GitHub code:

```text
PORT=8080
NODE_ENV=production
BASE_URL=https://www.agbslibrary.com
SESSION_SECRET=<long random secret>
ADMIN_EMAIL=<admin email>
ADMIN_BOOTSTRAP_PASSWORD=<admin bootstrap password only if needed>
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<app IAM access key>
AWS_SECRET_ACCESS_KEY=<app IAM secret key>
AWS_S3_BUCKET=agbs-library-books-india-567681717467-us-east-1-an
AWS_S3_PREFIX=agbs-library
AWS_STORAGE_BUDGET_GB=3000
AWS_STORAGE_PLAN_MONTHS=12
AWS_STORAGE_CREDIT_USD=1000
AWS_S3_STORAGE_USD_PER_GB_MONTH=0.023
GOOGLE_CLIENT_ID=<optional>
GOOGLE_CLIENT_SECRET=<optional>
GOOGLE_REDIRECT_URI=https://www.agbslibrary.com/auth/google/callback
```

Never commit real secrets to GitHub.

## DNS Records

Hostinger DNS should point to AWS:

```text
CNAME  www    Agbs-library-aws-1-env.eba-8uziqsiu.us-east-1.elasticbeanstalk.com
```

The root `@` record should use Hostinger root CNAME/ALIAS support if available. If not available, use Route 53 Alias for the root domain or keep `https://www.agbslibrary.com` as the official URL.

No Vercel DNS records should remain.

## AWS SSL/HTTPS

Completed setup:

1. In AWS Certificate Manager, request a public certificate for:
   - `agbslibrary.com`
   - `www.agbslibrary.com`
2. Use DNS validation.
3. Add the ACM validation CNAME records in Hostinger DNS.
4. Wait until ACM shows the certificate status as `Issued`.
5. Change the Elastic Beanstalk environment from single-instance to load-balanced.
6. Add an HTTPS listener on port `443`.
7. Attach the issued ACM certificate.
8. Test:
   - `https://www.agbslibrary.com`

## S3 CORS

The S3 bucket must allow browser uploads from the live domain:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "POST"],
    "AllowedOrigins": [
      "https://agbslibrary.com",
      "https://www.agbslibrary.com",
      "http://agbslibrary.com",
      "http://www.agbslibrary.com"
    ],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

## Upload Rules

- Use Chrome or Edge for very large folder uploads.
- Use **Open folder tree** in the admin upload panel.
- For mixed folders, choose **Auto Categorization - mixed books intake** as the upload category.
- Keep the computer awake while uploading.
- Uploads go directly to S3 where possible.
- Catalog writes are serialized so parallel uploads do not overwrite resource records.
- Exact duplicate files are skipped by content hash.
- ZIP files are opened in the browser and valid PDF/EPUB files inside are uploaded as individual books.
- The auto-categorization intake is not used as a final shelf; books are placed into the matching real library category.

## Verification Checklist

- Home page opens from the Elastic Beanstalk URL.
- `http://www.agbslibrary.com` opens the app.
- `https://www.agbslibrary.com` opens the app.
- `/api/config` reports `storageProvider: "aws-s3"`.
- Admin login works.
- Admin can upload one PDF.
- Admin can upload one EPUB.
- Admin can upload a folder with subfolders.
- Book appears in library search.
- Student can open the protected reader.
- Storage panel updates after upload.
- Storage panel shows total usable storage, used storage, remaining storage, and 12-month AWS credit coverage.
- GitHub contains the deployed code.

## Security Cleanup

If any AWS key, GitHub token, or admin password has appeared in chat, logs, screenshots, or browser history:

1. Create a replacement key or password.
2. Update Elastic Beanstalk environment properties.
3. Confirm the app still works.
4. Deactivate/delete the exposed old value.
