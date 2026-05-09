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

HTTP is active:

- `http://agbslibrary.com`
- `http://www.agbslibrary.com`
- `http://Agbs-library-aws-1-env.eba-8uziqsiu.us-east-1.elasticbeanstalk.com`

HTTPS is pending. Until AWS Certificate Manager and an HTTPS listener are configured, `https://` may time out.

## GitHub Rule

All code changes must be pushed to:

```text
https://github.com/Jayasree2020/AGBS-LIBRARY
```

Do not edit production files manually in AWS. Make changes in this repository, create a new Elastic Beanstalk application version ZIP, then deploy that version.

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
Environment type: Single instance
Proxy: nginx
App port: 8080
```

The current single-instance setup is enough for HTTP testing and admin work. AWS-only HTTPS requires moving the environment to a load-balanced configuration so an ACM certificate can be attached to a port 443 listener.

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
GOOGLE_CLIENT_ID=<optional>
GOOGLE_CLIENT_SECRET=<optional>
GOOGLE_REDIRECT_URI=https://www.agbslibrary.com/auth/google/callback
```

Never commit real secrets to GitHub.

## DNS Records

Hostinger DNS should point to AWS:

```text
A      @      34.192.31.166
CNAME  www    Agbs-library-aws-1-env.eba-8uziqsiu.us-east-1.elasticbeanstalk.com
```

No Vercel DNS records should remain.

## AWS SSL/HTTPS Plan

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
   - `https://agbslibrary.com`
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
- Keep the computer awake while uploading.
- Uploads go directly to S3 where possible.
- Catalog writes are serialized so parallel uploads do not overwrite resource records.
- Exact duplicate files are skipped by content hash.
- ZIP files are opened in the browser and valid PDF/EPUB files inside are uploaded as individual books.

## Verification Checklist

- Home page opens from the Elastic Beanstalk URL.
- `http://agbslibrary.com` opens the app.
- `http://www.agbslibrary.com` opens the app.
- `/api/config` reports `storageProvider: "aws-s3"`.
- Admin login works.
- Admin can upload one PDF.
- Admin can upload one EPUB.
- Admin can upload a folder with subfolders.
- Book appears in library search.
- Student can open the protected reader.
- Storage panel updates after upload.
- GitHub contains the deployed code.

## Security Cleanup

If any AWS key, GitHub token, or admin password has appeared in chat, logs, screenshots, or browser history:

1. Create a replacement key or password.
2. Update Elastic Beanstalk environment properties.
3. Confirm the app still works.
4. Deactivate/delete the exposed old value.
