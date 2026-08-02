import { z } from "zod";

export type ImageJobMessage = {
  imageJobId: string;
  imageRunId: string;
};

export const imageJobMessageSchema = z
  .object({
    imageJobId: z.uuid(),
    imageRunId: z.uuid(),
  })
  .strict();

export interface JobQueue {
  enqueue(message: ImageJobMessage): Promise<void>;
}
