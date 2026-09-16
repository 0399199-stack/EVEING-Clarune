# Clean-room boundary

## Allowed inputs

- Public product requirements and independently written specifications.
- Official documentation for Electron, React, Real-ESRGAN and ncnn.
- MIT/BSD source code used in compliance with its own license.
- Independently created EVEING branding, UI, copy and tests.

## Prohibited inputs

- Copying or adapting Upscayl application source code or `upscayl-ncnn` code.
- Copying Upscayl IPC names, UI hierarchy, icons, branding, text, translations,
  screenshots, bundled model collection, update endpoints or analytics setup.
- Importing files from the research clone at `work/upscayl-upstream`.

## Engineering rule

The commercial repository must be buildable without the Upscayl research
clone. Every inference binary and model must have a recorded source URL,
immutable version, SHA-256 and license decision before it enters a build.

