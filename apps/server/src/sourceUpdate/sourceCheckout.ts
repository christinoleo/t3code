import * as Config from "effect/Config";
import * as Option from "effect/Option";

export const SOURCE_CHECKOUT_ENV = "T3CODE_SOURCE_CHECKOUT";
export const SOURCE_UPDATE_COMMAND_ENV = "T3CODE_SOURCE_UPDATE_COMMAND";

/** The git checkout this server runs from; setting it opts into source updates. */
export const sourceCheckoutConfig = Config.String(SOURCE_CHECKOUT_ENV).pipe(
  Config.option,
  Config.map((value) =>
    Option.filter(
      Option.map(value, (path) => path.trim()),
      (path) => path.length > 0,
    ),
  ),
);
