import { powershell } from './exec.ts';

/**
 * Windows DPAPI (CurrentUser): the API key and the RabbitMQ password are stored encrypted, readable
 * only by this Windows account. Values travel through stdin as base64, never on a command line.
 */
async function dpapi(action: 'Protect' | 'Unprotect', values: string[]): Promise<string[]> {
  if (values.length === 0) return [];
  const script = `
Add-Type -AssemblyName System.Security
$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$result = @($items | ForEach-Object {
  [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::${action}([Convert]::FromBase64String($_), $null, $scope))
})
ConvertTo-Json -InputObject $result -Compress`;
  const result = await powershell(script, { input: JSON.stringify(values), timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`DPAPI ${action} falhou: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout) as string[];
}

/** Plain text -> base64 ciphertext. */
export async function protect(values: string[]): Promise<string[]> {
  return dpapi('Protect', values.map((value) => Buffer.from(value, 'utf8').toString('base64')));
}

/** Base64 ciphertext -> plain text. */
export async function unprotect(values: string[]): Promise<string[]> {
  return (await dpapi('Unprotect', values)).map((value) => Buffer.from(value, 'base64').toString('utf8'));
}
