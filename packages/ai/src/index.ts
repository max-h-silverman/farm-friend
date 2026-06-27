import type { z } from "zod";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateJsonRequest<TSchema extends z.ZodTypeAny> {
  seam: string;
  schemaVersion: string;
  messages: ModelMessage[];
  schema: TSchema;
  temperature?: number;
}

export interface LLMProvider {
  readonly name: string;
  generateJson<TSchema extends z.ZodTypeAny>(
    request: GenerateJsonRequest<TSchema>,
  ): Promise<z.infer<TSchema>>;
}

export class StubLLMProvider implements LLMProvider {
  readonly name = "stub";
  private readonly queue: unknown[] = [];

  push(value: unknown): void {
    this.queue.push(value);
  }

  async generateJson<TSchema extends z.ZodTypeAny>(
    request: GenerateJsonRequest<TSchema>,
  ): Promise<z.infer<TSchema>> {
    const next = this.queue.shift();
    return request.schema.parse(next);
  }
}
