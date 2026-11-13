import {
  BadgeCheck,
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleSlash,
  CircleX,
  Clock,
  Copy,
  EyeOff,
  FileClock,
  FileSearch,
  FileWarning,
  FlaskConical,
  Gauge,
  Hand,
  History,
  Hourglass,
  KeyRound,
  Landmark,
  LayoutList,
  Lock,
  LogIn,
  LogOut,
  type LucideIcon,
  Menu,
  PackageCheck,
  Plug,
  Plus,
  RefreshCw,
  Replace,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Ship,
  TestTube,
  Undo2,
  Unplug,
  Users,
  Wallet,
} from "lucide-react";
import type { IconName } from "../lib/status";

/** One stroke icon family (lucide), 1.75 px stroke. Decorative icons are hidden from AT. */
const STATUS_ICONS: Record<IconName, LucideIcon> = {
  paid: BadgeCheck,
  processing: Clock,
  unknown: CircleHelp,
  review: FileSearch,
  reconciling: RefreshCw,
  adjudication: Scale,
  locked: Lock,
  failed: CircleX,
  refunded: Undo2,
  cancelled: Ban,
  hold: Hand,
  dry: FlaskConical,
  "not-run": CircleDashed,
  blocked: ShieldAlert,
  authorized: ShieldCheck,
  expired: Hourglass,
  incomplete: FileWarning,
  complete: CircleCheck,
  stale: FileClock,
  hidden: EyeOff,
  limit: Gauge,
  connected: Plug,
  disconnected: Unplug,
  testnet: TestTube,
  pending: CircleDot,
  active: KeyRound,
  revoked: CircleSlash,
  receipt: PackageCheck,
  superseded: Replace,
};

export const UI_ICONS = {
  trades: LayoutList,
  inspections: FileSearch,
  payouts: Wallet,
  audit: ScrollText,
  organization: Users,
  signIn: LogIn,
  signOut: LogOut,
  menu: Menu,
  copy: Copy,
  alert: CircleAlert,
  brand: Ship,
  history: History,
  network: Landmark,
  plus: Plus,
  refresh: RefreshCw,
  key: KeyRound,
} as const;

/**
 * Dockside mark: two containers on the quay with a third lifted above them, drawn in the same
 * 1.75 px stroke as the icon family. Decorative; the visible product name carries the meaning.
 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 20.5h19" />
      <rect x="3.5" y="13.5" width="8" height="5" rx="0.75" />
      <rect x="12.5" y="13.5" width="8" height="5" rx="0.75" />
      <rect x="8" y="5" width="8" height="5" rx="0.75" />
      <path d="M12 2.5V5M6.5 15.5v1M8.5 15.5v1M15.5 15.5v1M17.5 15.5v1" />
    </svg>
  );
}

export function StatusIcon({ name, className }: { name: IconName; className?: string }) {
  const C = STATUS_ICONS[name];
  return <C aria-hidden="true" focusable="false" size={18} strokeWidth={1.75} className={className} />;
}

export function UiIcon({ name, size = 18 }: { name: keyof typeof UI_ICONS; size?: number }) {
  const C = UI_ICONS[name];
  return <C aria-hidden="true" focusable="false" size={size} strokeWidth={1.75} />;
}

export function statusIconComponent(name: IconName): LucideIcon {
  return STATUS_ICONS[name];
}
