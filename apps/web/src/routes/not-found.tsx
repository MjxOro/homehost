import { Link } from "@tanstack/react-router";
import { LINK_PRIMARY } from "../components/primitives";

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center">
      <h1 className="text-[18px] font-bold">Page not found</h1>
      <p className="max-w-[54ch] text-[14px] leading-[1.6] text-text-2">
        Nothing lives at this path. Head back to the dashboard.
      </p>
      <Link to="/" className={LINK_PRIMARY}>
        Go to dashboard
      </Link>
    </div>
  );
}
