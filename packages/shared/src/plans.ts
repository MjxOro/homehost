export interface Plan {
  id: string;
  name: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  /** Max active servers one owner may hold on this plan. */
  maxServers: number;
  /** True = requires trusted tier / approval; untrusted requests get 403. */
  trustedOnly: boolean;
}

export const PLANS: Plan[] = [
  { id: "game-small", name: "Game Small", cpu: 2, memoryMb: 2048, diskGb: 20, maxServers: 1, trustedOnly: false },
  { id: "vm-medium", name: "VM Medium", cpu: 4, memoryMb: 4096, diskGb: 40, maxServers: 3, trustedOnly: true },
  { id: "vm-large", name: "VM Large", cpu: 8, memoryMb: 8192, diskGb: 80, maxServers: 5, trustedOnly: true },
];
