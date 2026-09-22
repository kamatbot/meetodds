#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
typedef void (*cb)(uint64_t,const char*);
void md_speech_start(uint64_t,const char*,cb); _Bool md_speech_push(uint64_t,const float*,uint32_t,uint32_t,double); void md_speech_finish(uint64_t); void md_speech_cancel(uint64_t);
void md_speech_capabilities(uint64_t,cb); void md_speech_prepare(uint64_t,const char*,_Bool,cb);
struct state { int capabilities, error, ready, partial, final, final_text, finished, cancelled, late; double final_start,final_end; };
static struct state s[16]; static pthread_mutex_t mu=PTHREAD_MUTEX_INITIALIZER; static pthread_cond_t cv=PTHREAD_COND_INITIALIZER; static int bad;
static int has(const char *j,const char *x){return j&&strstr(j,x);}
static double num(const char *j,const char *x){const char *p=strstr(j,x);return p?strtod(p+strlen(x),0):NAN;}
static void callback(uint64_t id,const char *j){
  printf("%llu %s\n",(unsigned long long)id,j); fflush(stdout); if(id>=16)return;
  pthread_mutex_lock(&mu); struct state *v=&s[id]; if(v->finished||v->cancelled){v->late++;bad=1;}
  if(has(j,"\"kind\":\"capabilities\""))v->capabilities++;
  if(has(j,"\"kind\":\"error\""))v->error++;
  if(has(j,"\"kind\":\"ready\""))v->ready++;
  if(has(j,"\"kind\":\"result\"")){double a=num(j,"\"start\":"),b=num(j,"\"end\":");int final=has(j,"\"isFinal\":true");if(!isfinite(a)||!isfinite(b)||a<0||b<a||(final&&v->final&&(a<v->final_start||b<v->final_end)))bad=1;if(final){v->final_start=a;v->final_end=b;v->final++;if(has(j,"fixed pub."))v->final_text++;}else v->partial++;}
  if(has(j,"\"kind\":\"finished\""))v->finished++; pthread_cond_broadcast(&cv); pthread_mutex_unlock(&mu);
}
static int wait_field(int id,int *field,int n,int sec){struct timespec t;clock_gettime(CLOCK_REALTIME,&t);t.tv_sec+=sec;pthread_mutex_lock(&mu);while(*field<n&&!bad){if(pthread_cond_timedwait(&cv,&mu,&t))break;}int ok=*field>=n&&!bad;pthread_mutex_unlock(&mu);return ok;}
static int feed(int id,float *x,size_t n,size_t max){if(max&&n>max)n=max;for(size_t i=0;i<n;i+=1024){size_t z=n-i<1024?n-i:1024;if(!md_speech_push(id,x+i,(uint32_t)z,48000,(double)i/48000.0))return 0;usleep(21333);}return 1;}
static int feed_pair(int left,int right,float *x,size_t n){for(size_t i=0;i<n;i+=1024){size_t z=n-i<1024?n-i:1024;double t=(double)i/48000.0;if(!md_speech_push(left,x+i,(uint32_t)z,48000,t)||!md_speech_push(right,x+i,(uint32_t)z,48000,t))return 0;usleep(21333);}return 1;}
int main(void){const char *p=getenv("APPLE_SPEECH_RAW");FILE *f=p?fopen(p,"rb"):0;if(!f)return 2;fseek(f,0,SEEK_END);long bytes=ftell(f);rewind(f);float *x=malloc((size_t)bytes);if(!x||bytes<=0||fread(x,1,(size_t)bytes,f)!=(size_t)bytes)return 2;fclose(f);size_t n=(size_t)bytes/sizeof(float);
  md_speech_capabilities(1,callback);if(!wait_field(1,&s[1].capabilities,1,20))return 10;
  md_speech_prepare(2,"zz-ZZ",0,callback);if(!wait_field(2,&s[2].error,1,20))return 11;
  md_speech_start(3,"en-US",callback);if(!wait_field(3,&s[3].ready,1,20))return 12;md_speech_finish(3);if(!wait_field(3,&s[3].finished,1,20)||s[3].error)return 13;
  md_speech_start(10,"en-US",callback);if(!wait_field(10,&s[10].ready,1,20)||!feed(10,x,n,0)||!wait_field(10,&s[10].partial,1,12))return 3;md_speech_finish(10);if(!wait_field(10,&s[10].finished,1,20)||s[10].final<1||s[10].error)return 4;
  md_speech_start(11,"en-US",callback);if(!wait_field(11,&s[11].ready,1,20)||!feed(11,x,n,48000))return 5;md_speech_cancel(11);pthread_mutex_lock(&mu);s[11].cancelled=1;pthread_mutex_unlock(&mu);usleep(500000);if(s[11].late||s[11].error)return 6;
  md_speech_start(12,"en-US",callback);if(!wait_field(12,&s[12].ready,1,20)||!feed(12,x,n,48000))return 7;md_speech_finish(12);if(!wait_field(12,&s[12].finished,1,20)||!s[12].final_text||s[12].error)return 8;
  md_speech_start(13,"en-US",callback);md_speech_cancel(13);pthread_mutex_lock(&mu);s[13].cancelled=1;pthread_mutex_unlock(&mu);usleep(500000);if(s[13].late||s[13].error)return 14;
  md_speech_start(14,"en-US",callback);md_speech_start(15,"en-US",callback);if(!wait_field(14,&s[14].ready,1,20)||!wait_field(15,&s[15].ready,1,20)||!feed_pair(14,15,x,n))return 15; if(!wait_field(14,&s[14].partial,1,12)||!wait_field(15,&s[15].partial,1,12))return 16;md_speech_finish(14);md_speech_finish(15);if(!wait_field(14,&s[14].finished,1,20)||!wait_field(15,&s[15].finished,1,20)||!s[14].final||!s[15].final||s[14].error||s[15].error)return 17;free(x);return bad?9:0;}
