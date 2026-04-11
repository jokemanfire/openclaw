
/* Started by Cursor 10026780.A25624033 20260324250000008 */
import http from 'http';

console.log('Testing rule matching service at http://localhost:18790');

// Test 1: Health check
console.log('\n=== Test 1: Health check ===');
const healthOptions = {
  hostname: 'localhost',
  port: 18790,
  path: '/health',
  method: 'GET'
};

const healthReq = http.request(healthOptions, (res) => {
  console.log(`Health check status: ${res.statusCode}`);
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('Health check response:', data);
    testChatCompletions();
  });
});

healthReq.on('error', (error) => {
  console.error('❌ Health check failed:', error.message);
  console.error('Make sure the rule matching service is running!');
});

healthReq.end();

// Test 2: Chat completions
function testChatCompletions() {
  console.log('\n=== Test 2: Chat completions ===');
  
  const postData = JSON.stringify({
    model: "rule-matching-model",
    messages: [
      { role: "user", content: "关闭蓝牙" }
    ]
  });

  const options = {
    hostname: 'localhost',
    port: 18790,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Authorization': 'Bearer dummy-key'
    }
  };

  const req = http.request(options, (res) => {
    console.log(`Chat completions status: ${res.statusCode}`);
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      console.log('Chat completions response:');
      console.log(data);
      try {
        const json = JSON.parse(data);
        if (json.choices && json.choices[0]) {
          console.log('\n✅ Assistant response:', json.choices[0].message.content);
        }
      } catch (e) {
        console.error('Failed to parse JSON:', e);
      }
    });
  });

  req.on('error', (error) => {
    console.error('❌ Chat completions failed:', error.message);
  });

  req.write(postData);
  req.end();
}
/* Ended by Cursor 10026780.A25624033 20260324250000008 */
