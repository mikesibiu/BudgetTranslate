#!/bin/bash
# upload-to-gcloud.sh — Upload glossary CSVs to Google Cloud Storage
# and create (or replace) both Translation API glossaries.
#
#   ro-en-religious-terms  →  ro→en direction  (glossary_final.csv)
#   en-ro-religious-terms  →  en→ro direction  (glossary_final_en_ro.csv)
#
# Run this as a GCP project owner/editor (the gtranslate-v4 service account
# lacks Storage permissions, so this must be run with owner credentials).
#
# Usage:  bash glossaries/upload-to-gcloud.sh

set -e

PROJECT=mlf-gtranslate
LOCATION=us-central1
BUCKET=mlf-gtranslate-glossaries
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TOKEN=$(gcloud auth print-access-token)
GLOSSARY_API="https://translation.googleapis.com/v3/projects/${PROJECT}/locations/${LOCATION}/glossaries"

echo "══════════════════════════════════════════"
echo "  GTranslate Glossary Upload"
echo "══════════════════════════════════════════"
echo "  Project:  $PROJECT"
echo "  Bucket:   gs://$BUCKET"
echo "  Location: $LOCATION"
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

# Helper: delete a glossary if it exists, then create it fresh
create_glossary() {
  local GLOSSARY_ID="$1"
  local SRC_LANG="$2"
  local TGT_LANG="$3"
  local CSV_FILE="$4"
  local GCS_URI="gs://${BUCKET}/${GLOSSARY_ID}.csv"

  echo ""
  echo "────────────────────────────────────────"
  echo "  Glossary: $GLOSSARY_ID  ($SRC_LANG → $TGT_LANG)"
  echo "  CSV:      $CSV_FILE"
  echo "────────────────────────────────────────"

  echo "▶ Uploading CSV to GCS..."
  gsutil cp "$CSV_FILE" "$GCS_URI"
  echo "   Uploaded → $GCS_URI"

  echo "▶ Deleting existing glossary (if any)..."
  curl -s -o /dev/null \
    -X DELETE \
    -H "Authorization: Bearer $TOKEN" \
    "${GLOSSARY_API}/${GLOSSARY_ID}" \
    && sleep 5 \
    || echo "   No existing glossary to delete."

  echo "▶ Creating glossary from GCS URI..."
  RESPONSE=$(curl -s \
    -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$GLOSSARY_API" \
    -d "{
      \"name\": \"projects/${PROJECT}/locations/${LOCATION}/glossaries/${GLOSSARY_ID}\",
      \"languagePair\": {
        \"sourceLanguageCode\": \"${SRC_LANG}\",
        \"targetLanguageCode\": \"${TGT_LANG}\"
      },
      \"inputConfig\": {
        \"gcsSource\": {
          \"inputUri\": \"${GCS_URI}\"
        }
      }
    }")

  echo "▶ API response:"
  echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d,indent=2))" 2>/dev/null || echo "$RESPONSE"
}

# 3. Create ro→en glossary
create_glossary \
  "ro-en-religious-terms" \
  "ro" "en" \
  "${SCRIPT_DIR}/glossary_final.csv"

# 4. Create en→ro glossary (columns-swapped version of the same 734 entries)
create_glossary \
  "en-ro-religious-terms" \
  "en" "ro" \
  "${SCRIPT_DIR}/glossary_final_en_ro.csv"

echo ""
echo "══════════════════════════════════════════"
echo "✅ Done. Both glossaries submitted."
echo ""
echo "   Check status:"
echo "   gcloud translate glossaries describe ro-en-religious-terms --location=$LOCATION"
echo "   gcloud translate glossaries describe en-ro-religious-terms --location=$LOCATION"
echo ""
echo "   Set GLOSSARY_ENABLED=true in your hosting env once both show ACTIVE."
echo "══════════════════════════════════════════"
