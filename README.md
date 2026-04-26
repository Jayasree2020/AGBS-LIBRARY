# AGBS LIBRARY

A secure web app for an off-campus seminary library: admin-managed PDF/EPUB uploads, department categories, protected in-app reading, student login, and usage reporting.

## Run locally

```powershell
node server.js
```

Open `http://localhost:3000`.

On this Windows machine, you can also double-click `START-AGBS-LIBRARY.cmd` and keep that window open while using the app.

The local preview uses JSON files under `data/` and stores uploaded resources under `storage/`. For production, set `MONGODB_URI` and deploy with the dependencies in `package.json` installed.

## Deploy

The project includes `vercel.json` for Vercel preview deployments. For real book uploads in production, configure `MONGODB_URI` and move uploaded files to durable object storage such as Vercel Blob or S3-compatible storage.

## Security notes

- Do not commit `.env`, MongoDB credentials, Google OAuth secrets, or passwords.
- The previously shared admin password must be treated as exposed. Create/reset the admin password after deployment.
- Students cannot upload files.
- Downloads are not exposed in the interface; resources are streamed through authenticated routes with inline display headers.

## Default access

Set `ADMIN_EMAIL` in the environment. On first launch, that email is created as an admin with no password. Use the setup screen to create the first password.
