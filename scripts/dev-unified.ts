#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { DevEnvironment } from './lib/dev-environment.js';

const { values } = parseArgs({
  options: {
    mode: {
      type: 'string',
      default: 'auto',
    },
    monitoring: {
      type: 'boolean',
      default: true, // User requested "always include"
    },
    'dry-run': {
      type: 'boolean',
      default: false,
    },
    clean: {
      type: 'boolean',
      default: false,
    },
    verbose: {
      type: 'boolean',
      default: false,
    },
  },
  allowPositionals: false,
});

// Validate mode
const validModes = ['auto', 'k8s', 'docker', 'simple'];
if (values.mode && !validModes.includes(values.mode)) {
  console.error(`Invalid mode: ${values.mode}`);
  console.error(`Valid modes: ${validModes.join(', ')}`);
  process.exit(1);
}

// Create and start development environment
async function main() {
  const env = new DevEnvironment({
    mode: values.mode as 'auto' | 'k8s' | 'docker' | 'simple',
    monitoring: values.monitoring,
    dryRun: values['dry-run'],
    clean: values.clean,
    verbose: values.verbose,
  });

  try {
    await env.start();
  } catch (error) {
    console.error('\nError starting development environment:', error);
    process.exit(1);
  }
}

main();
