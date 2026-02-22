# Custom Glossary Guide

This guide explains how to build and use a custom Romanian-English translation glossary from parallel documents.

## Quick Start

### 1. Add Your Documents

Place your parallel documents in the `documents/` directory:

```bash
documents/
├── document_ro.pdf   # Romanian version
└── document_en.pdf   # English version
```

**Supported formats:** PDF (EPUB support coming soon)

**Important:** The documents should be parallel translations of the same content (e.g., same book/magazine in both languages).

### 2. Build the Glossary

Run the glossary builder:

```bash
node build-glossary.js
```

This will:
- Extract text from both PDFs
- Identify frequently-used Romanian terms
- Translate them to English
- Generate a CSV glossary file in `glossaries/`

### 3. Review the Glossary

Open the generated CSV file:

```bash
open glossaries/glossary_YYYY-MM-DD.csv
```

**Format:**
```csv
ro,en
iehova,jehovah
predicare,preaching
adunare,congregation
```

**Review and edit:**
- Remove incorrect translations
- Add custom translations
- Fix capitalization
- Add specialized terms

### 4. Upload to Google Cloud (Coming Soon)

The next step will automatically upload your glossary to Google Cloud Translation API.

For now, you can manually upload using `gcloud`:

```bash
# Create a Cloud Storage bucket
gsutil mb gs://your-bucket-name

# Upload glossary
gsutil cp glossaries/glossary_YYYY-MM-DD.csv gs://your-bucket-name/

# Create glossary in Translation API
gcloud translate glossaries create my-glossary \
  --source-language=ro \
  --target-language=en \
  --input-uri=gs://your-bucket-name/glossary_YYYY-MM-DD.csv
```

### 5. Use the Glossary in Translations

After uploading, your translations will automatically use the custom terminology!

## Adding More Documents

To expand your glossary with additional documents:

1. **Replace the existing documents** in `documents/` with new ones
2. **Run the builder again:** `node build-glossary.js`
3. **Merge glossaries:** Combine multiple CSV files if needed

```bash
# Merge multiple glossaries
cat glossaries/glossary_*.csv | sort -u > glossaries/master_glossary.csv
```

## Advanced: Multiple Document Pairs

To process multiple document pairs, rename them:

```bash
documents/
├── watchtower_2024_01_ro.pdf
├── watchtower_2024_01_en.pdf
├── watchtower_2024_02_ro.pdf
├── watchtower_2024_02_en.pdf
```

Then process each pair:

```bash
# Process first pair
cp documents/watchtower_2024_01_ro.pdf documents/document_ro.pdf
cp documents/watchtower_2024_01_en.pdf documents/document_en.pdf
node build-glossary.js

# Process second pair
cp documents/watchtower_2024_02_ro.pdf documents/document_ro.pdf
cp documents/watchtower_2024_02_en.pdf documents/document_en.pdf
node build-glossary.js

# Merge all glossaries
cat glossaries/*.csv | grep -v "^ro,en" | sort -u > glossaries/master_glossary.csv
echo "ro,en" | cat - glossaries/master_glossary.csv > temp && mv temp glossaries/master_glossary.csv
```

## Troubleshooting

**"PDF extraction failed"**
- Ensure PDF is not encrypted/password-protected
- Try converting PDF to a simpler format
- Check if PDF has actual text (not scanned images)

**"Too many/few terms extracted"**
- Edit `build-glossary.js` and adjust the minimum frequency threshold (currently 3)
- Change `topRoTerms.slice(0, 100)` to extract more/fewer terms

**"Translations look wrong"**
- This is expected! The builder creates a starting point
- Manually review and correct the CSV file
- Focus on specialized religious/technical terms

## Next Steps

Future enhancements:
- [ ] EPUB support
- [ ] Automatic glossary upload to Google Cloud
- [ ] Better term alignment using sentence matching
- [ ] Web interface for glossary editing
- [ ] Support for multiple language pairs
