# AWS Hosting Guide For AGBS LIBRARY

This guide moves the app hosting from Vercel to AWS while keeping GitHub as the source of truth.

## Target Architecture

```text
GitHub repository
        |
        v
AWS App Runner or ECS/Fargate
        |
        v
AWS S3 bucket
  - agbs-library/books/
  - agbs-library/data/
  - agbs-library/tmp/
```

Recommended first AWS hosting choice: **AWS App Runner**.

Why App Runner:

- It runs this Node app without managing a server.
- It can connect to GitHub or to a container image built from this repository.
- It works well because book uploads go directly to S3, so the web server is not carrying the full 400 GB upload load.

## GitHub Rule

All code changes must be pushed to:

```text
https://github.com/Jayasree2020/AGBS-LIBRARY
```

Do not edit production files manually in AWS. Make changes in this repository, then redeploy AWS from GitHub/container.

## Files Added For AWS

- `Dockerfile`: packages the Node app for AWS hosting.
- `.dockerignore`: keeps secrets, local data, and temporary files out of the container.

## Required AWS Environment Variables

Set these in the AWS hosting service, not in GitHub code:

```text
PORT=3000
NODE_ENV=production
BASE_URL=https://www.agbslibrary.com
SESSION_SECRET=<long random secret>
ADMIN_EMAIL=<admin email>
ADMIN_BOOTSTRAP_PASSWORD=<admin password only if needed>
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

## S3 CORS

The S3 bucket must allow browser upload from the live domain:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "POST"],
    "AllowedOrigins": [
      "https://agbslibrary.com",
      "https://www.agbslibrary.com"
    ],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

## App Runner Deployment Steps

1. Push all latest code to GitHub.
2. In AWS Console, search **App Runner**.
3. Create service.
4. Choose a source:
   - If AWS offers GitHub source for this repo, connect `Jayasree2020/AGBS-LIBRARY`.
   - If using container image, build this repo using the included `Dockerfile`, push the image to ECR, then connect App Runner to that ECR image.
5. Set service port to `3000`.
6. Add every required environment variable above.
7. Deploy.
8. Open the temporary App Runner URL and confirm `/api/config` shows:

```json
{
  "storageProvider": "aws-s3"
}
```

9. Move the custom domain:
   - Add `agbslibrary.com` and `www.agbslibrary.com` to App Runner custom domains.
   - Update DNS records exactly as AWS shows.
   - Wait for HTTPS certificate validation.

## Upload Rules After AWS Move

- Use Chrome or Edge for very large folder uploads.
- Use **Open folder tree** in the admin upload panel.
- Keep the computer awake while uploading.
- Uploads go directly to S3 where possible.
- Catalog writes are serialized so parallel uploads do not overwrite resource records.
- Failed direct uploads retry with AWS form upload, then safe chunked upload.

## Verification Checklist

- Home page opens from AWS URL.
- Admin login works.
- `/api/config` reports AWS S3 storage.
- Admin can upload one PDF.
- Admin can upload one EPUB.
- Admin can upload a folder with subfolders.
- Book appears in library search.
- Student can open the protected reader.
- Storage panel updates after upload.
- GitHub contains the deployed code.
