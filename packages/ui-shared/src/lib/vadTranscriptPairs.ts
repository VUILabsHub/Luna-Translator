// Compatibility shim: the implementation moved to @simultrans/core as part of
// the packages/core extraction (contract v1). New code should import from
// packages/core directly; this re-export keeps existing imports stable until
// the codemod cleanup pass.
export * from '@simultrans/core/vadTranscriptPairs'
