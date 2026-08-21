import * as v from "valibot";

import { factorLabelSchema } from "../../contracts/accountSecurity.ts";

export const optionalFactorLabelFormSchema = v.strictObject({
    label: v.union([v.literal(""), factorLabelSchema]),
});
