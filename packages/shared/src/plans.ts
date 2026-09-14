export interface Plan {
  id: string;
  name: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  /** Requires the technical friend tier; every request still needs approval. */
  technicalOnly: boolean;
  /** Tenant unit: shared-kernel container or full KVM virtual machine. */
  kind: "container" | "vm";
  /** Incus image alias, e.g. images:ubuntu/24.04. */
  image: string;
}

export const PLANS: Plan[] = [
  {
    id: "game-small",
    name: "Game Small",
    cpu: 2,
    memoryMb: 2048,
    diskGb: 20,
    technicalOnly: false,
    kind: "container",
    image: "images:ubuntu/24.04",
  },
  {
    id: "vm-medium",
    name: "VM Medium",
    cpu: 4,
    memoryMb: 4096,
    diskGb: 40,
    technicalOnly: true,
    kind: "vm",
    image: "images:ubuntu/24.04/cloud",
  },
  {
    id: "vm-large",
    name: "VM Large",
    cpu: 8,
    memoryMb: 8192,
    diskGb: 80,
    technicalOnly: true,
    kind: "vm",
    image: "images:ubuntu/24.04/cloud",
  },
];
