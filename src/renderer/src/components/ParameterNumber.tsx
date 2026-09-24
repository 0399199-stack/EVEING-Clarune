import { useLayoutEffect, useState } from "react";
import "./parameter-number.css";

export default function ParameterNumber({ value, min, max, step = 1, onChange, label, testId, disabled = false } : {
  value: number; min: number; max: number; step?: number; onChange: (value: number) => void;
  label: string; testId?: string; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useLayoutEffect(() => { setDraft(String(value)); }, [value]);
  const normalize = (number: number) => Math.max(min, Math.min(max, Number((Math.round(number / step) * step).toFixed(6))));
  return <input className="parameter-number" type="number" min={min} max={max} step={step}
    value={draft} aria-label={label} data-testid={testId} disabled={disabled}
    onChange={event => {
      const text = event.target.value; setDraft(text);
      const next = event.target.valueAsNumber;
      if (text !== "" && Number.isFinite(next) && next >= min && next <= max && normalize(next) !== value) onChange(normalize(next));
    }}
    onBlur={event => {
      const text = event.currentTarget.value;
      const next = text.trim() === "" ? value : Number(text);
      const result = normalize(Number.isFinite(next) ? next : value);
      setDraft(String(result)); if (result !== value) onChange(result);
    }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") setDraft(String(value));
    }} />;
}
