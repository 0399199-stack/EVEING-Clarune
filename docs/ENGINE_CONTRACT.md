# Inference worker contract — draft

The UI must not depend directly on a specific command-line syntax. A single
adapter owns process launch, progress parsing, cancellation and error mapping.

## Request

- Input path
- Temporary output path ending in `.partial`
- Model identifier and immutable model hash
- Scale or target dimension
- Tile size and GPU identifier
- Output format and quality

## Result

- Stable result/error code
- Process exit code
- Started and finished timestamps
- Input/output pixel dimensions
- Output byte length and decode result
- Sanitized diagnostic excerpt

## Success invariant

`exitCode === 0` is necessary but not sufficient. The output must exist, have
non-zero length, decode completely and match the expected pixel dimensions.
Only then may the temporary file be atomically committed to its final name.

