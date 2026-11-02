// Isolated connector fixture. It never contacts Cloudflare or sends email.
import {createServer,request} from 'node:http';
import {connect} from 'node:net';
import {writeFileSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
const args=process.argv.slice(2);
if(args.includes('--help')) { console.log('--allowed-mail --unix-socket');process.exit(0); }
const values=new Set(['--config','--output','--loglevel','--protocol','--allowed-mail','--metrics','--grace-period']);
const flags=new Set(['--no-autoupdate','--hello-world','--management-diagnostics=false']);
for(let i=1;i<args.length;i++) {
  if(values.has(args[i])){i++;continue;}
  if(flags.has(args[i]) || args[i]==='ingress' || args[i]==='validate')continue;
  console.error('Incorrect Usage. flag provided but not defined: '+args[i]);process.exit(1);
}
const get=name=>args[args.indexOf(name)+1], configPath=get('--config'), socketPath=JSON.parse(readFileSync(configPath,'utf8')).ingress[0].service.slice(5), email=get('--allowed-mail');
if(!socketPath || !args.includes('--hello-world') || get('--output')!=='json')throw new Error('Expected private Unix ingress and JSON output');
if(args.includes('validate')){console.log('OK');process.exit(0);}
const config=JSON.parse(readFileSync(join(dirname(process.argv[1]),'quick-fixture.json'),'utf8'));
writeFileSync(config.state,JSON.stringify({pid:process.pid,socketPath,email,args}));
const sockets=new Set();
const edge=createServer((req,res)=>{
  if(req.url==='/fixture-login') {res.writeHead(200,{'set-cookie':'fixture_quick_login=owner; HttpOnly; Path=/; SameSite=Lax','content-type':'text/html'});res.end('<a href="/">Continue</a>');return;}
  if(!req.headers.cookie?.includes('fixture_quick_login=owner')) {
    res.writeHead(req.method==='GET'?302:401,{'location':'/fixture-login','content-type':'text/html'});res.end('Fixture email verification');return;
  }
  const upstream=request({socketPath,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
});
edge.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
edge.on('upgrade',(req,socket,head)=>{
  if(!req.headers.cookie?.includes('fixture_quick_login=owner')){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
  const upstream=connect(socketPath,()=>{
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key,value])=>`${key}: ${value}`).join('\r\n')}\r\n\r\n`);
    upstream.write(head);upstream.pipe(socket);socket.pipe(upstream);
  });upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
});
edge.listen(config.port,'127.0.0.1',()=>{
  const log=message=>process.stderr.write(JSON.stringify({level:'info',message})+'\n');
  log(config.unprotected?'Your quick Tunnel has been created!':'Your protected quick Tunnel has been created! Visit it at:');
  log('https://fixture-quick.trycloudflare.com');log('Registered tunnel connection connIndex=0');
});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{for(const socket of sockets)socket.destroy();edge.close(()=>process.exit(0));});
