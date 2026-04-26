# AGBS LIBRARY

AGBS LIBRARY is a secure digital library for off-campus seminary students. It is designed for controlled access to PDF, EPUB, and image-based study resources, with department-based categorization, admin-managed uploads, and reading activity tracking.

Live site: [https://www.agbslibrary.com](https://www.agbslibrary.com)

Fallback Vercel URL: [https://agbs-library.vercel.app](https://agbs-library.vercel.app)

## What It Does

- Provides student and admin login.
- Organizes resources by seminary departments.
- Lets admins upload individual files, ZIP files, or whole folders.
- Supports PDF, EPUB, PNG, JPG, JPEG, WEBP, and GIF files.
- Suggests categories from file and folder names.
- Keeps uploaded resources pending until admin review.
- Tracks login sessions, reading sessions, opened books, and reading time.
- Keeps download links out of the interface and serves files through authenticated routes.

## Library Departments

- Old Testament
- New Testament
- Christian Theology
- History of Christianity
- Christian Ministry
- Missiology
- Communication
- Christian Ethics
- Religions
- Social Analysis
- Women Studies

## Admin Upload Workflow

Admins can upload normal files, a ZIP archive, or a full folder. The upload screen supports two modes:

- `Auto-categorize`: the app uses file and folder names to suggest the correct department.
- `Manual category`: the whole upload batch goes into one selected department.

Uploaded resources remain in review until an admin publishes them.

## Deployment

The app is deployed on Vercel under the `agbs-library` project and is connected to the custom domain:

[https://www.agbslibrary.com](https://www.agbslibrary.com)

Vercel is suitable for the live preview and app interface. For long-term production use with many large PDF/EPUB files, connect durable storage such as Vercel Blob, S3-compatible storage, or another file-storage provider. Vercel serverless temporary storage can reset and should not be treated as permanent book storage.

## Environment Variables

Set these in Vercel Project Settings:

```text
ADMIN_EMAIL
ADMIN_BOOTSTRAP_PASSWORD
SESSION_SECRET
BASE_URL
MONGODB_URI
MONGODB_DB
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
```

`ADMIN_BOOTSTRAP_PASSWORD`, OAuth secrets, database URLs, and API keys must stay in Vercel environment variables. Do not commit them to GitHub.

## Local Development

```powershell
node server.js
```

Then open:

[http://localhost:3000](http://localhost:3000)

On this Windows workspace, `START-AGBS-LIBRARY.cmd` can also start the local server.

## Security Notes

- Secrets are kept out of the repository.
- Students cannot upload resources.
- Admin-only routes are protected server-side.
- Resources are served through authenticated app routes.
- Browser-level screenshots or copying cannot be fully prevented, but ordinary public download exposure is avoided.
