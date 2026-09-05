import { z } from 'zod';
import { PetType } from '@/database/generated/prisma/enums';
import { assertFreeAiModel, FREE_AI_PROVIDER } from './free-ai-policy';
import { OpenRouterProvider } from '@/ai/providers/openrouter.provider';
import { MOCK_AI_ANALYSIS_RESULT } from '@/ai/mock-ai.data';
import { AiLogService } from '@/ai/service/ai-log.service';
import { AiAnalysisResult } from '@/ai/types/ai-analysis-result.type';
import { OpenRouterChatCompletion } from '@/ai/types/openrouter.type';
import { ai_feature } from '@/database/generated/prisma/enums';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';

@Injectable()
export class AiService {
  constructor(
    private readonly openRouterProvider: OpenRouterProvider,
    private readonly configService: ConfigService,
    private readonly aiLogService: AiLogService,
  ) {}

  async testConnection() {
    const requestedModel = this.configService.getOrThrow<string>(
      'AI_ANALYZE_IMAGE_MODEL',
    );

    if (this.isMockMode()) {
      return 'PAWND AI MOCK READY';
    }

    assertFreeAiModel(requestedModel);
    const client = this.openRouterProvider.getClient();

    try {
      const response = (await client.chat.completions.create({
        model: requestedModel,
        messages: [
          {
            role: 'user',
            content: 'Reply with PAWND AI READY',
          },
        ],
        max_tokens: 50,
        provider: FREE_AI_PROVIDER,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParams)) as OpenRouterChatCompletion;

      await this.createAiSuccessLog(
        ai_feature.ANALYZE_IMAGE,
        requestedModel,
        response,
      );

      return response.choices?.[0]?.message.content;
    } catch (error: unknown) {
      await this.createAiErrorLog(
        ai_feature.ANALYZE_IMAGE,
        requestedModel,
        error,
      );

      throw error;
    }
  }
  async analyzeImage(imageUrl: string): Promise<AiAnalysisResult> {
    const requestedModel = this.configService.getOrThrow<string>(
      'AI_ANALYZE_IMAGE_MODEL',
    );

    if (this.isMockMode()) {
      return { ...MOCK_AI_ANALYSIS_RESULT };
    }

    try {
      return await this.runImageAnalysis(requestedModel, imageUrl);
    } catch (error: unknown) {
      await this.createAiErrorLog(
        ai_feature.ANALYZE_IMAGE,
        requestedModel,
        error,
      );

      if (!this.isRateLimitError(error)) {
        throw new ServiceUnavailableException(
          'AI วิเคราะห์ภาพยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง',
        );
      }

      const fallbackModel = this.configService.getOrThrow<string>(
        'AI_ANALYZE_IMAGE_MODEL_FREE',
      );

      console.warn(
        `[AiService.analyzeImage] "${requestedModel}" is rate limited, falling back to "${fallbackModel}"`,
      );

      try {
        return await this.runImageAnalysis(fallbackModel, imageUrl);
      } catch (fallbackError: unknown) {
        await this.createAiErrorLog(
          ai_feature.ANALYZE_IMAGE,
          fallbackModel,
          fallbackError,
        );

        throw new ServiceUnavailableException(
          'โควตา AI ฟรีอาจเต็มชั่วคราว กรุณาลองใหม่ภายหลัง',
        );
      }
    }
  }

  private async runImageAnalysis(
    model: string,
    imageUrl: string,
  ): Promise<AiAnalysisResult> {
    assertFreeAiModel(model);
    const client = this.openRouterProvider.getClient();

    const response = (await client.chat.completions.create({
      model,
      provider: { ...FREE_AI_PROVIDER, require_parameters: true },

      messages: [
        {
          role: 'system',
          content: `
You are an AI pet image analysis assistant for PAWND, a lost and found pet platform.

Your task is to analyze ONLY the visible physical characteristics of the pet that are useful for identifying or matching the pet.

Rules:
- Do not guess or invent information.
- Classify the pet type as DOG, CAT, BIRD, HAMSTER, EXOTIC, or OTHER.
- The "type" field MUST always use the English enum value: DOG, CAT, BIRD, HAMSTER, EXOTIC, or OTHER.
- If the pet type cannot be reliably classified into the supported categories, use OTHER.
- Do not infer gender, age, name, owner information, or other information that cannot be reliably determined from the image.
- For optional attributes that cannot be reliably determined, return null.
- The "breed", "color", "distinctiveFeatures", and "description" fields MUST be written in Thai.

Analysis requirements:
- Focus only on the pet itself.
- Ignore the background and surrounding environment completely.
- Do not describe what the pet is doing, its pose, position, movement, or behavior.
- Do not mention floors, furniture, buildings, people, vehicles, scenery, or other background objects.
- Do not describe camera angle or image composition.

Field requirements:
- "breed": Identify the breed only when visually reliable; otherwise return null.
- "color": Describe only the pet's fur, feather, skin, or body colors and visible patterns.
- "distinctiveFeatures": Describe visible identifying features such as collars, tags, bows, scars, markings, patches, ear shape, tail characteristics, or other distinguishing features.
- Use correct pet-related terminology. For example, a collar worn around the neck must be described as "ปลอกคอ", not "สายสะพาย".
- "description": Provide a concise identification-focused summary of the pet's physical appearance only. Combine useful characteristics such as body color, patterns, coat characteristics, facial markings, ear characteristics, tail characteristics, and distinctive accessories.
- Do not repeat environmental information in "description".
- Keep the description concise and useful for lost-and-found pet identification and matching.
`.trim(),
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this pet image and return the pet attributes.',
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],

      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'pet_image_analysis',
          strict: true,

          schema: {
            type: 'object',

            properties: {
              type: {
                type: 'string',
                enum: Object.values(PetType),
              },

              breed: {
                type: ['string', 'null'],
              },

              color: {
                type: ['string', 'null'],
              },

              distinctiveFeatures: {
                type: ['string', 'null'],
              },

              description: {
                type: ['string', 'null'],
              },
            },

            required: [
              'type',
              'breed',
              'color',
              'distinctiveFeatures',
              'description',
            ],

            additionalProperties: false,
          },
        },
      },

      max_tokens: 1200,

      // model can be a reasoning model (e.g. nemotron ...
      // :free). Without this, the model may spend its whole budget
      // narrating its reasoning ("The user wants...") into
      // message.content and never emit the JSON answer, even with
      // response_format set. `exclude: true` keeps the reasoning
      // internal so content is left for the actual structured output.
      reasoning: {
        exclude: true,
      },
    } as OpenAI.Chat.Completions.ChatCompletionCreateParams)) as OpenRouterChatCompletion;

    await this.createAiSuccessLog(ai_feature.ANALYZE_IMAGE, model, response);

    if (response.error) {
      throw new Error(
        `OpenRouter error: ${response.error.message ?? 'unknown error'}`,
      );
    }

    const content = response.choices?.[0]?.message.content;

    if (!content) {
      throw new Error('AI returned empty response');
    }

    const result = this.parseAnalysisResult(content);

    return result;
  }
  // บาง reasoning model ไม่ยอมทำตาม response_format จริง ๆ
  // เลยอาจส่ง markdown code fence หรือ chain-of-thought
  // แทรกก่อน/หลัง JSON มาด้วย จึงต้อง extract JSON object ออกมาก่อน parse
  private parseAnalysisResult(content: string): AiAnalysisResult {
    try {
      return this.validateAnalysis(JSON.parse(content));
    } catch {
      const match = content.match(/\{[\s\S]*\}/);

      if (match) {
        try {
          return this.validateAnalysis(JSON.parse(match[0]));
        } catch {
          // fall through to the error below
        }
      }

      throw new Error(
        `AI returned a non-JSON response: ${content.slice(0, 200)}`,
      );
    }
  }

  /** ตรวจคำตอบจากโมเดลจริงก่อนส่งไปกรอกฟอร์ม ป้องกันชนิดข้อมูลและ enum ผิด */
  private validateAnalysis(value: unknown): AiAnalysisResult {
    return z
      .object({
        type: z.enum(PetType),
        breed: z.string().nullable(),
        color: z.string().nullable(),
        distinctiveFeatures: z.string().nullable(),
        description: z.string().nullable(),
      })
      .parse(value);
  }

  //ส่วนย่อย ai log
  private isMockMode(): boolean {
    return this.configService.get<boolean>('AI_MOCK_MODE') ?? true;
  }

  // OpenRouter/upstream providers can signal rate limiting either as an
  // SDK-level HTTP 429 or, for free models, as a 200 response carrying a
  // `response.error` body (see OpenRouterChatCompletion) whose message we
  // wrap into an Error above — so both shapes need checking here.
  private isRateLimitError(error: unknown): boolean {
    if (
      error instanceof Error &&
      'status' in error &&
      (error as { status?: unknown }).status === 429
    ) {
      return true;
    }

    const message = error instanceof Error ? error.message : '';

    return /rate.?limit|resource.?exhausted|\b429\b/i.test(message);
  }

  private async createAiSuccessLog(
    feature: ai_feature,
    requestedModel: string,
    response: OpenRouterChatCompletion,
  ): Promise<void> {
    const resolvedModel = response.model ?? requestedModel;

    await this.aiLogService.createAiLog({
      feature,

      requestedModel,
      resolvedModel,

      provider: response.provider ?? null,
      generationId: response.id ?? null,

      inputTokens: response.usage?.prompt_tokens ?? null,
      outputTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,

      costUsd: response.usage?.cost ?? null,

      fallbackUsed: requestedModel !== resolvedModel,

      finishReason: response.choices?.[0]?.finish_reason ?? null,

      streaming: false,
      success: true,
    });
  }

  private async createAiErrorLog(
    feature: ai_feature,
    requestedModel: string,
    error: unknown,
  ): Promise<void> {
    const errorCode =
      error instanceof Error && 'status' in error ? String(error.status) : null;

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown AI error';

    await this.aiLogService.createAiLog({
      feature,

      requestedModel,
      resolvedModel: requestedModel,

      provider: null,
      generationId: null,

      fallbackUsed: false,

      streaming: false,
      success: false,

      errorCode,
      errorMessage,
    });
  }
}
