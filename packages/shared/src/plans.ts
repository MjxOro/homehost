export type DesktopEnv = "ubuntu-xfce" | "omarchy";

/** KasmVNC desktop baked into a GUI VM plan. */
export interface DesktopConfig {
  env: DesktopEnv;
  /** X display the VNC server binds, e.g. ":5". */
  display: string;
  /** KasmVNC websocket port serving the browser canvas. */
  kasmPort: number;
  /** Raw VNC port (loopback-only, never routed). */
  vncPort: number;
  /** Public-facing web port on the guest (equals kasmPort). */
  webPort: number;
}

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
  /** Present only on GUI desktop plans; controls the KasmVNC bake. */
  desktop?: DesktopConfig;
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
  {
    id: "desktop-ubuntu",
    name: "Desktop Ubuntu",
    cpu: 2,
    memoryMb: 2048,
    diskGb: 20,
    technicalOnly: true,
    kind: "vm",
    image: "images:ubuntu/24.04/cloud",
    desktop: {
      env: "ubuntu-xfce",
      display: ":5",
      kasmPort: 6090,
      vncPort: 5905,
      webPort: 6090,
    },
  },
  {
    id: "desktop-omarchy",
    name: "Desktop Omarchy",
    cpu: 4,
    memoryMb: 4096,
    diskGb: 40,
    technicalOnly: true,
    kind: "vm",
    image: "images:archlinux/cloud",
    desktop: {
      env: "omarchy",
      display: ":5",
      kasmPort: 6090,
      vncPort: 5905,
      webPort: 6090,
    },
  },
];
