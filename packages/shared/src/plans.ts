export interface Plan {
  id: string;
  name: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  /** Requires a server-assigned trusted tier; every request still needs approval. */
  trustedOnly: boolean;
}

export const PLANS: Plan[] = [
  {
    id: "game-small",
    name: "Game Small",
    cpu: 2,
    memoryMb: 2048,
    diskGb: 20,
    trustedOnly: false,
  },
  {
    id: "vm-medium",
    name: "VM Medium",
    cpu: 4,
    memoryMb: 4096,
    diskGb: 40,
    trustedOnly: true,
  },
  {
    id: "vm-large",
    name: "VM Large",
    cpu: 8,
    memoryMb: 8192,
    diskGb: 80,
    trustedOnly: true,
  },
];
