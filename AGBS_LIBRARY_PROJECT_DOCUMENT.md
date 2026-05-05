# AGBS LIBRARY Project Document

## Current Live Project

Project name: AGBS LIBRARY

Live site: https://www.agbslibrary.com

Fallback Vercel URL: https://agbs-library.vercel.app

GitHub repository: https://github.com/Jayasree2020/AGBS-LIBRARY

Vercel project: `agbs-library`

This app is a secure digital seminary library for fewer than 100 off-campus students. It allows students to log in, browse books by department, read files inside the app, and have their reading activity recorded. Admins manage books, users, categories, and reports.

## Main Purpose

The app is meant to help AGBS students access seminary resources from home. The books/resources are PDF, EPUB, and image files. Students should be able to read them inside the browser without public file links or download buttons.

The app also records student usage so the admin/director can see login history, books opened, and total reading hours.

## User Roles

- `student`: can log in, browse the library, search resources, and read published files.
- `admin`: can upload and manage resources, manage users/categories, and view reports.
- `director`: supported as a staff role with admin-style access.

Students cannot upload files.

## Login

The app supports:

- Email/password login.
- Admin bootstrap login from environment variables.
- Google sign-in when Google OAuth environment variables are configured.

Sensitive values such as admin password, GitHub tokens, Vercel tokens, Google OAuth secrets, AWS access keys, and session secrets must never be committed into GitHub.

## Library Departments

The current default departments are:

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

Admins can also add categories from the admin dashboard.

## Student Library

Students see the library in a list/table format. They can:

- Browse all resources.
- Filter by category.
- Search by any word, including title, author, file name, format, or category.
- Open resources using the `Read` button.

Files are served through protected app routes, not public storage URLs.

## Admin Dashboard

The admin dashboard currently includes:

- Book/file upload.
- Folder upload.
- ZIP upload.
- Auto-categorization by file/folder name.
- Manual category selection.
- Upload stop button.
- Library file management.
- Skipped duplicate upload list.
- Student/user creation.
- Category creation.
- Student history reports.

## Upload Behavior

Admins can upload:

- Single PDF/EPUB/image files.
- Multiple files.
- A folder.
- ZIP archives.

Supported formats:

- PDF
- EPUB
- PNG
- JPG/JPEG
- WEBP
- GIF

When uploading, the app checks every file and does the following:

- Supported new files are added directly to the library.
- Files are automatically marked as published.
- Files are treated as e-books and receive automatic Dewey Decimal-style classification.
- A bibliography entry is generated for every e-book.
- Duplicate files are skipped.
- Skipped files are shown only to admins under `Skipped duplicate uploads`.
- Large uploads are internally sent in smaller chunks, but the final library record remains the real PDF/EPUB/image file, not a chunk or part.

## Duplicate Handling

The app prevents repeated files by checking:

- File hash, when available.
- Normalized file name plus file size.

If a file already exists, it is skipped and recorded for admin review. This prevents the student library from filling with repeated copies.

## Admin File Management

Admins can manage uploaded files with these actions:

- `View`: open the uploaded file through the protected route.
- `Save`: update the title or category.
- `Replace`: upload a new file in place of the existing one.
- `Remove`: delete the library record and stored file.

There is no longer a publish-pending step. Uploads are automated.

## Reading And Tracking

The app records:

- Login sessions.
- Logout/session end when available.
- Reading session start.
- Reading session end.
- Resource opened.
- Category accessed.
- Total reading time.

The admin report shows student totals such as:

- Number of logins.
- Books opened.
- Reading hours.

Students do not see other students' records.

## Storage And Database

The app can run with local JSON files for development, but production uses AWS S3.

AWS S3 production storage:

- Book files are stored as one object per PDF/EPUB/image under `books/`.
- Small app records are stored as JSON objects under `data/`.
- Large uploads may travel in temporary upload steps, but the final stored object is still one complete file.

Required AWS environment variables:

```text
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_S3_BUCKET
AWS_S3_PREFIX
AWS_STORAGE_BUDGET_GB
AWS_STORAGE_PLAN_MONTHS
```

`AWS_STORAGE_BUDGET_GB` is set to `3000` and `AWS_STORAGE_PLAN_MONTHS` is set to `12` by default so the dashboard tracks storage against a one-year AWS-credit plan.

JSON record files stored in AWS S3:

- `users`
- `categories`
- `resources`
- `uploadBatches`
- `loginSessions`
- `readingSessions`
- `accessEvents`
- `skippedUploads`

Important production note:

Vercel serverless file storage is temporary. Permanent uploaded books and app records now go to AWS S3.

## Environment Variables

Set these in Vercel Project Settings:

```text
ADMIN_EMAIL
ADMIN_BOOTSTRAP_PASSWORD
SESSION_SECRET
BASE_URL
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_S3_BUCKET
AWS_S3_PREFIX
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
```

Never place real values for these in GitHub or frontend files.

## Current Important Behavior

- Uploads go directly to the library.
- Admin dashboard shows only total storage left and estimated month runway.
- Admin dashboard includes classification and bibliography export buttons for HTML, Word-compatible, Excel-compatible, CSV, and PDF files.
- No publish button is required.
- Duplicate files are skipped.
- Skipped duplicates are admin-only.
- Admins can view, update, replace, and remove files.
- Students read through protected routes.
- Search supports any word and optional category.
- Password visibility toggle exists on login.
- The upload stop button is available during uploads.

## Known Limitations

- Browser-level screenshots and copying cannot be fully prevented.
- EPUB reading is served through the protected route; deeper EPUB-specific page/location tracking may need a dedicated EPUB reader library later.
- Permanent file reliability depends on AWS S3 staying configured in Vercel.
- Google sign-in works only after Google OAuth credentials are set correctly in Vercel.

## Suggested Next Work

1. Upload books directly through the admin dashboard.
2. Watch the AWS storage panel after each upload batch.
3. Confirm large batch upload speed with real seminary folders.
4. Configure Google OAuth credentials for Gmail sign-in.
5. Add better PDF/EPUB page-location tracking if required.
6. Add export buttons for admin reports if the director needs Excel/PDF reporting.

## Safe Continuation Notes

When continuing this project:

- Do not expose tokens or passwords in code, GitHub, README files, screenshots, or frontend JavaScript.
- Keep students blocked from uploads.
- Keep admin-only reports protected server-side.
- Test upload, duplicate skip, view, replace, remove, and student reading after every major change.
- Push changes to GitHub and deploy to Vercel after fixes are confirmed.
