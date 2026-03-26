import axios from 'axios';
import type { AppConfig } from './config';
import type { SendMessageInput } from './schemas';

export class BandwidthClient {
  constructor(private readonly config: AppConfig) {}

  async sendMessage(input: SendMessageInput): Promise<unknown> {
    const url = `${this.config.BANDWIDTH_MESSAGING_API_BASE_URL}/users/${this.config.BANDWIDTH_ACCOUNT_ID}/messages`;
    const response = await axios.post(
      url,
      {
        applicationId: this.config.BANDWIDTH_APPLICATION_ID,
        from: input.from,
        to: [input.to],
        text: input.text
      },
      {
        auth: {
          username: this.config.BANDWIDTH_API_TOKEN,
          password: this.config.BANDWIDTH_API_SECRET
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  }
}
