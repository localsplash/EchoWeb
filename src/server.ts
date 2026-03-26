import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const app = buildApp();

app.listen(config.PORT, () => {
  console.log(`EchoMessagingService listening on :${config.PORT}`);
});
