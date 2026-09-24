import brandMark from "../../../../resources/branding/clarune-a.svg";
import "./brand-mark.css";

export function BrandMark({ large = false }: { large?: boolean }) {
  return (
    <img
      className={`clarune-brand-image${large ? " is-large" : ""}`}
      src={brandMark}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={large ? 58 : 36}
      height={large ? 58 : 36}
    />
  );
}
