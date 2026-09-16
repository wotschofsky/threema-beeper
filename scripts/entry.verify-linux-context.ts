import assert from 'node:assert/strict';
import {verifyContextIntegrity} from './linux-context-integrity.ts';
assert(process.argv.length === 3, 'Usage: node scripts/entry.verify-linux-context.ts <context>');
console.log(`Verified Linux build context: ${verifyContextIntegrity(process.argv[2]!)}`);
