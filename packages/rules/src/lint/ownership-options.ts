import { z } from "zod";

export const ownershipOptionsSchema = z.object({
  allowOwnershipTransfer: z.boolean(),
}).strict();
