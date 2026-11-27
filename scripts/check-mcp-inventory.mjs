import { open } from 'node:fs/promises';
import { checkMcpDeploymentInventory } from '../src/host/mcp-deployment-policy.mjs';

// This input must contain only the documented secret-free inventory, not MCP config.
try {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-mcp-inventory.mjs <secret-free-inventory.json>');
  const file = await open(process.argv[2], 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536) throw new Error('Inventory must be a regular file of at most 65536 bytes');
    let inventory;
    try { inventory = JSON.parse(await file.readFile('utf8')); }
    catch { throw new Error('Inventory is not valid JSON'); }
    const result = checkMcpDeploymentInventory(inventory);
    if (!result.ok) { for (const error of result.errors) console.error(error); process.exitCode = 1; }
    else console.log('Attested MCP inventory meets the configured version policy.');
  } finally { await file.close(); }
} catch (error) { console.error('Inventory check failed:', error.message); process.exitCode = 1; }
