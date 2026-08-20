// Entry shim: some loader paths resolve a bare `team-delegate` to this
// directory and then look for a default entry instead of honoring
// package.json exports/main. Re-export from lib so either resolution works.
export * from './lib/index.js'
