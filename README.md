# Universal Writing Overlay

A local-first Electron + React desktop overlay for writing workflows:

- Progressive auto typing with chunking, delay, pause/resume/stop, skip, logging, and a global emergency stop.
- Citation claim extraction with public source retrieval, source quality labels, manual source entry, inline citations, and bibliography output.
- Personal writing style profile creation from samples, local style rewriting, before/after review, and consistency checks.
- Rubric checker with strict/devil's advocate modes, annotated draft feedback, score/risk estimates, revision plans, and Markdown/PDF/DOCX/clipboard exports.

## Run

```bash
npm install
npm run dev
```

The overlay is designed for macOS first. Auto typing and selected-text capture use macOS Accessibility automation through System Events, so macOS may ask for Accessibility permission the first time.

## Build

```bash
npm run build
```

## AI Citation Verification

Citation search works without AI by using public metadata APIs and stricter local ranking. To enable semantic source verification, start the app with `OPENAI_API_KEY` set. The default verification model is `gpt-5.4-mini`; override it with `OPENAI_CITATION_MODEL` if needed.

## Local Data

Profiles, logs, saved citations, reports, and revision history are stored in Electron's app data folder as `writing-overlay-data.json`.
