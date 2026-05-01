/**
 * Validator module entry point.
 *
 * Provides the validator registry (VALIDATORS) and the factory function
 * (getValidator).
 *
 * How it works:
 *   1. All validator classes are registered in VALIDATORS (name -> class).
 *   2. YAML workflow configs reference validators by name: validator: "simple_json".
 *   3. At runtime, getValidator("simple_json") looks up the class and returns
 *      new SimpleJSONValidator(config).
 *
 * To add a new validator:
 *   1. Create a new file, extend BaseValidator, and implement name and validate().
 *   2. Import the new validator class in this file.
 *   3. Add one registration line to VALIDATORS: my_validator: MyValidator.
 */

// BaseValidator is the abstract base class for all validators. It defines
// validate() and name, and is re-exported at the bottom of this file.
import { BaseValidator } from "./base.js";
// SimpleJSONValidator only checks that the basic `页码` and `内容` fields exist.
// It does not validate the nested content structure.
import { SimpleJSONValidator } from "./simple_json_validator.js";
// PDFPageValidator builds on SimpleJSONValidator and also verifies paragraph key
// continuity (`段落1`, `段落2`, ...).
import { PDFPageValidator } from "./pdf_page_validator.js";

// ============================================================
// Validator Registry
// ============================================================

/**
 * Validator registry: maps validator names to validator classes.
 *
 * Type explanation:
 *   Record<string, new (config: Record<string, unknown>) => BaseValidator>
 *   means { [name: string]: constructor }.
 *
 *   `new (config: ...) => BaseValidator` is a TypeScript construct signature.
 *   It describes a class that can be called with `new`, accepts a config
 *   argument, and returns a BaseValidator instance.
 *   Therefore VALIDATORS["simple_json"] is the class itself, not an instance.
 *
 * Example:
 *   const Cls = VALIDATORS["simple_json"];  // -> SimpleJSONValidator class
 *   const v = new Cls({ strict: true });    // -> SimpleJSONValidator instance
 */
export const VALIDATORS: Record<string, new (config: Record<string, unknown>) => BaseValidator> = {
  simple_json: SimpleJSONValidator,
  pdf_page: PDFPageValidator,
};

// ============================================================
// Factory Function
// ============================================================

/**
 * Create a validator instance by name.
 *
 * This is the single external entry point for validator creation. It wraps
 * lookup and instantiation so callers only need the validator name from YAML,
 * not the concrete validator class.
 *
 * Example:
 *   const v = getValidator("simple_json", { strict: true });
 *   v.validate(parsedData);  // returns true or throws Error
 *
 * @param name   Validator name from YAML, such as "simple_json".
 * @param config Optional validator config passed through to the constructor.
 * @returns      BaseValidator instance.
 * @throws Error If the validator name is unknown. The error lists all available
 *               validator names.
 */
export function getValidator(
  name: string,
  config: Record<string, unknown> = {}
): BaseValidator {
  // Look up the matching class in the registry.
  const ValidatorClass = VALIDATORS[name];

  // If the name is not registered, report all available options.
  if (!ValidatorClass) {
    const available = Object.keys(VALIDATORS).sort();
    throw new Error(
      `Unknown validator: '${name}'\n\n` +
        `Available validators:\n  ${available.join(", ")}\n\n` +
        `Usage:\n  Specify it in YAML config:\n` +
        `  validator: "${available[0] ?? "validator_name"}"`
    );
  }

  // Instantiate and return the validator.
  // This is the value of the factory pattern: callers pass a name string, while
  // the factory handles lookup and object creation.
  // Without this factory, every caller would need to import each concrete
  // validator class and choose one with if/switch logic.
  // With the factory, adding a validator only requires one line in VALIDATORS.
  return new ValidatorClass(config);
}

// Re-export these classes so external modules can import from validators/index.ts
// instead of reaching into validators/base.js or validators/simple_json_validator.js.
// Example: import { BaseValidator, SimpleJSONValidator } from "./validators/index.js"
export { BaseValidator };
export { SimpleJSONValidator };
export { PDFPageValidator };
