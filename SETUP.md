# GTranslate V4 - Google Cloud Speech-to-Text Setup Guide

## Overview
GTranslate V4 uses **Google Cloud Speech-to-Text API** for real-time speech recognition, eliminating the 60-second timeout limitation of the Web Speech API.

## Prerequisites
- Google Cloud account
- Node.js installed
- Terminal access

---

## Step 1: Enable Google Cloud Speech-to-Text API

### 🔗 Direct Links:

1. **Create or select a Google Cloud Project:**
   https://console.cloud.google.com/projectcreate

2. **Enable Speech-to-Text API:**
   https://console.cloud.google.com/apis/library/speech.googleapis.com

   Click **"Enable"**

3. **Enable Translation API** (if not already enabled):
   https://console.cloud.google.com/apis/library/translate.googleapis.com

   Click **"Enable"**

---

## Step 2: Create Service Account and Download Credentials

### 🔗 Direct Link:
https://console.cloud.google.com/iam-admin/serviceaccounts

### Steps:

1. Click **"+ CREATE SERVICE ACCOUNT"** at the top

2. Fill in:
   - **Service account name:** `gtranslate-v4`
   - **Service account ID:** (auto-filled)
   - **Description:** `Service account for GTranslate V4 speech recognition and translation`

3. Click **"CREATE AND CONTINUE"**

4. **Grant roles** - Add these two roles:
   - **Cloud Translation API User**
   - **Cloud Speech Client** (or **Cloud Speech-to-Text API Agent** if available)

   Click **"CONTINUE"** then **"DONE"**

5. **Create and download the key:**
   - Find your new service account in the list
   - Click the **three dots (⋮)** on the right
   - Select **"Manage keys"**
   - Click **"ADD KEY"** → **"Create new key"**
   - Choose **"JSON"**
   - Click **"CREATE"**

   **IMPORTANT:** The JSON file will download automatically. Save it as `google-credentials.json` in the GtranslateV4 folder.

---

## Step 3: Install Dependencies

```bash
cd GtranslateV4
npm install
```

---

## Step 4: Configure Environment

The credentials file should be named `google-credentials.json` and placed in the `GtranslateV4` folder.

**Directory structure should be:**
```
GtranslateV4/
├── google-credentials.json  ← Your downloaded credentials
├── server.js
├── index.html
├── package.json
└── SETUP.md
```

---

## Step 5: Start the Server

```bash
node server.js
```

Open your browser to: **http://localhost:3003**

---

## Pricing Information

### Google Cloud Speech-to-Text Pricing:
- **First 60 minutes per month:** FREE
- **After that:** $0.006 per 15 seconds (≈ $1.44 per hour)

### Google Cloud Translation Pricing:
- **First 500,000 characters per month:** FREE
- **After that:** $20 per 1 million characters

**For typical usage (testing, personal use), you'll likely stay within the free tier.**

---

## Troubleshooting

### "Credentials file not found"
- Make sure `google-credentials.json` is in the `GtranslateV4` folder
- Check the filename exactly matches (case-sensitive)

### "API not enabled"
- Go back to the links above and ensure both APIs are enabled
- Wait a few minutes after enabling for changes to take effect

### "Permission denied"
- Make sure you added the correct roles to the service account
- Try creating a new service account key

---

## Key Differences from V3

| Feature | V3 (Web Speech API) | V4 (Google Cloud) |
|---------|-------------------|-------------------|
| **Timeout** | 60 seconds max | No timeout |
| **Accuracy** | Good | Excellent |
| **Language Support** | Limited | 125+ languages |
| **Cost** | Free | Free tier, then paid |
| **Setup** | Simple | Requires credentials |
| **Offline** | No | No |

---

## Security Notes

⚠️ **IMPORTANT:** Never commit `google-credentials.json` to version control!

The `.gitignore` file is already configured to exclude it.
