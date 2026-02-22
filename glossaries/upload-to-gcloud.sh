#!/bin/bash
# upload-to-gcloud.sh — Upload the clean glossary CSV to Google Cloud
# and create (or replace) the Translation API glossary.
#
# Run this as a GCP project owner/editor (the gtranslate-v4 service account
# lacks Storage permissions, so this must be run with owner credentials).
#
# Usage:  bash glossaries/upload-to-gcloud.sh

set -e

PROJECT=mlf-gtranslate
LOCATION=us-central1
BUCKET=mlf-gtranslate-glossaries
GLOSSARY_ID=ro-en-religious-terms
CSV="$(cd "$(dirname "$0")" && pwd)/glossary_final.csv"
GCS_URI="gs://${BUCKET}/${GLOSSARY_ID}.csv"

echo "══════════════════════════════════════════"
echo "  GTranslate Glossary Upload"
echo "══════════════════════════════════════════"
echo "  Project:    $PROJECT"
echo "  Bucket:     gs://$BUCKET"
echo "  Glossary:   $GLOSSARY_ID"
echo "  CSV:        $CSV"
echo "══════════════════════════════════════════"
echo ""

# 1. Create GCS bucket if it doesn't exist
echo "▶ Creating GCS bucket (if needed)..."
gsutil mb -l "$LOCATION" "gs://$BUCKET" 2>/dev/null || echo "   Bucket already exists — continuing."

# 2. Grant the service account read access to the bucket
echo "▶ Granting service account objectViewer on bucket..."
gsutil iam ch \
  "serviceAccount:gtranslate-v4@mlf-gtranslate.iam.gserviceaccount.com:objectViewer" \
  "gs://$BUCKET" 2>/dev/null || true

# 3. Upload the CSV
echo "▶ Uploading CSV to GCS..."
gsutil cp "$CSV" "$GCS_URI"
echo "   Uploaded → $GCS_URI"

# 4. Delete existing glossary if present (can't update in place)
echo "▶ Deleting existing glossary (if any)..."
curl -s -o /dev/null \
  -X DELETE \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://translation.googleapis.com/v3/projects/${PROJECT}/locations/${LOCATION}/glossaries/${GLOSSARY_ID}" \
  && sleep 5 \
  || echo "   No existing glossary to delete."

# 5. Create the new glossary
echo "▶ Creating glossary from GCS URI..."
RESPONSE=$(curl -s \
  -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://translation.googleapis.com/v3/projects/${PROJECT}/locations/${LOCATION}/glossaries" \
  -d "{
    \"name\": \"projects/${PROJECT}/locations/${LOCATION}/glossaries/${GLOSSARY_ID}\",
    \"languagePair\": {
      \"sourceLanguageCode\": \"ro\",
      \"targetLanguageCode\": \"en\"
    },
    \"inputConfig\": {
      \"gcsSource\": {
        \"inputUri\": \"${GCS_URI}\"
      }
    }
  }")

echo "▶ API response:"
echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d,indent=2))" 2>/dev/null || echo "$RESPONSE"

echo ""
echo "✅ Done. Set GLOSSARY_ENABLED=true in Heroku once the glossary shows as ACTIVE."
echo "   Check status: gcloud translate glossaries describe $GLOSSARY_ID --location=$LOCATION"
