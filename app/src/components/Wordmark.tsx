import { Link } from "react-router-dom";

// The "boon" wordmark — lowercase Fraunces, custom letterspacing, olive seal dot.
interface Props {
  size?: "sm" | "md" | "lg" | "hero";
  href?: string;
  withMark?: boolean;
}

const SIZE_CLASSES: Record<NonNullable<Props["size"]>, string> = {
  sm: "text-xl",
  md: "text-2xl",
  lg: "text-4xl",
  hero: "text-7xl sm:text-8xl md:text-9xl",
};

export function Wordmark({ size = "md", href, withMark = true }: Props) {
  const cls = `wordmark ${SIZE_CLASSES[size]}`;
  const inner = (
    <>
      boon
      {withMark && (
        <span
          className={`wordmark-mark${size === "hero" ? " wordmark-mark-hero" : ""}`}
          aria-hidden="true"
        />
      )}
    </>
  );
  if (href) {
    return (
      <Link to={href} className={cls} aria-label="boon — home">
        {inner}
      </Link>
    );
  }
  return <span className={cls}>{inner}</span>;
}
