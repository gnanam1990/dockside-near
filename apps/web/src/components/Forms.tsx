import { forwardRef, type ReactNode } from "react";
import { UiIcon } from "./Icon";

export interface FieldError {
  readonly fieldId: string;
  readonly message: string;
}

/** Persistent label, helper text and inline error wired with aria-describedby. */
export function Field({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string | undefined;
  children: (aria: { id: string; "aria-describedby": string; "aria-invalid": boolean }) => ReactNode;
}) {
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {help ? (
        <span id={`${id}-help`} className="field__help">
          {help}
        </span>
      ) : null}
      {children({ id, "aria-describedby": describedBy, "aria-invalid": Boolean(error) })}
      {error ? (
        <span id={`${id}-error`} className="field__error">
          <UiIcon name="alert" />
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Focusable error summary linking to each invalid field (focused by the caller after submit). */
export const ErrorSummary = forwardRef<HTMLElement, { errors: readonly FieldError[]; serverError?: string }>(
  function ErrorSummary({ errors, serverError }, ref) {
    if (errors.length === 0 && !serverError) return null;
    return (
      <section className="error-summary" tabIndex={-1} ref={ref} aria-labelledby="error-summary-title">
        <h2 id="error-summary-title">There is a problem</h2>
        <ul>
          {serverError ? <li>{serverError}</li> : null}
          {errors.map((e) => (
            <li key={e.fieldId}>
              <a href={`#${e.fieldId}`}>{e.message}</a>
            </li>
          ))}
        </ul>
      </section>
    );
  },
);
