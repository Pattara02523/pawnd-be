import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

@Injectable()
export class OpenRouterProvider {
  private readonly client?: OpenAI;

  constructor(private readonly configService: ConfigService) {
    const mockMode = this.configService.get<boolean>('AI_MOCK_MODE') ?? true;

    if (!mockMode) {
      this.client = new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        timeout: 30000,
        maxRetries: 0, // จำกัดเวลาและจำนวนคำขอในโควตาฟรี
        apiKey: this.configService.getOrThrow<string>('OPENROUTER_API_KEY'),
        defaultHeaders: {
          'X-OpenRouter-Title': 'PAWND',
        },
      });
    }
  }

  getClient() {
    if (!this.client) {
      throw new Error(
        'OpenRouter client is unavailable while AI_MOCK_MODE=true',
      );
    }

    return this.client;
  }
}
