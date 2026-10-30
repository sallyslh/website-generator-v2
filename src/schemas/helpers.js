// Shared helper for all schema files: builds a validate(data) function
// that returns { ok, data, errors } with readable "path: problem" messages.

export function makeValidate(schema) {
  return function validate(data) {
    const result = schema.safeParse(data);
    if (result.success) return { ok: true, data: result.data, errors: [] };
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    return { ok: false, data: null, errors };
  };
}
