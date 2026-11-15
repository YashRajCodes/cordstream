export function hasAdministratorPermission(guild: { owner?: boolean; permissions?: string }) {
  if (guild.owner) return true;
  try {
    return (BigInt(guild.permissions ?? "0") & 8n) !== 0n;
  } catch {
    return false;
  }
}

const permissionBits: Array<[string, bigint]> = [
  ["Administrator", 8n],
  ["Manage Server", 32n],
  ["Manage Channels", 16n],
  ["Manage Roles", 268435456n],
  ["Manage Messages", 8192n],
  ["Manage Webhooks", 536870912n],
  ["Kick Members", 2n],
  ["Ban Members", 4n],
  ["View Channels", 1024n],
  ["Send Messages", 2048n],
  ["Connect to Voice", 1048576n],
  ["Speak", 2097152n],
];

export function namesForPermissions(value: string) {
  try {
    const permissions = BigInt(value);
    if ((permissions & 8n) !== 0n) return ["Administrator"];
    return permissionBits.filter(([, bit]) => (permissions & bit) === bit).map(([name]) => name);
  } catch {
    return [];
  }
}
