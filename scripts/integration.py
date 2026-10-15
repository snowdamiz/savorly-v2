"""Run against a local API + disposable local Postgres. Creates and removes isolated test accounts."""
import json, os, time, urllib.request, urllib.error, uuid
BASE = os.environ.get('TEST_API_URL', 'http://localhost:8080') + '/v1'
passed = 0

def request(path, method='GET', data=None, token=None, expected=200, origin=None):
 global passed
 headers = {'Content-Type':'application/json'}
 if token: headers['Authorization'] = 'Bearer ' + token
 if origin: headers['Origin'] = origin
 req=urllib.request.Request(BASE+path,method=method,headers=headers,data=json.dumps(data).encode() if data is not None else None)
 try:
  with urllib.request.urlopen(req,timeout=30) as r: status,body=r.status,r.read()
 except urllib.error.HTTPError as e: status,body=e.code,e.read()
 assert status==expected, f'{method} {path}: expected {expected}, got {status}: {body[:500]}'
 passed+=1
 return json.loads(body) if body else None

suffix=uuid.uuid4().hex[:12]
password='a-long-local-test-password'
accounts=[]
try:
 request('/library',expected=401)
 a=request('/auth/register','POST',{'name':'Integration Cook','email':f'test-{suffix}@example.test','password':password})['token'];accounts.append(a)
 b=request('/auth/register','POST',{'name':'Another Cook','email':f'other-{suffix}@example.test','password':password})['token'];accounts.append(b)
 me=request('/me',token=a)
 assert 'password' not in str(me) and me['admin'] is False
 request('/admin/overview',expected=401)
 request('/admin/overview',token=a,expected=403)
 request('/admin/users/'+me['id']+'/suspend','POST',{'reason':'Not an admin'},a,403)
 request('/auth/login','POST',{'email':f'test-{suffix}@example.test','password':'wrong'},expected=401)
 request('/me','PATCH',{'name':'Updated Cook','bio':'Testing my kitchen','avatar':'','preferences':{'diets':['Vegetarian'],'allergies':['Peanuts']}},a)
 request('/collections','POST',{'name':'Blocked'},a,expected=403,origin='https://evil.example')
 source=request('/recipes')[0]
 recipe={k:source[k] for k in ('title','description','cuisine','minutes','servings','difficulty','image','video','ingredients','steps','tags','calories','aiGenerated','published')}
 recipe.update(title=f'Integration pasta {suffix}',published=False)
 draft=request('/recipes','POST',recipe,a,201)
 request('/recipes/'+draft['id'],expected=404)
 request('/recipes/'+draft['id'],token=a)
 request('/recipes/'+draft['id'],'PUT',recipe,b,404)
 request('/recipes/'+draft['id']+'/save','PUT',{},b,404)
 recipe['published']=True
 published=request('/recipes/'+draft['id'],'PUT',recipe,a)
 rid=published['id']
 assert len(request('/recipes?q='+suffix))==1
 c=request('/collections','POST',{'name':'Weeknight favorites'},b)
 request('/recipes/'+rid+'/save','PUT',{'collectionId':c['id']},b)
 request('/recipes/'+rid+'/save','PUT',{'collectionId':c['id']},a,404)
 lib=request('/library',token=b);assert rid in lib['savedIds'] and lib['recipes'][0]['id']==rid
 request('/recipes/'+rid+'/review','PUT',{'rating':5,'body':'A really good dinner.'},b)
 request('/recipes/'+rid+'/review','PUT',{'rating':9,'body':'Nope'},b,400)
 request('/recipes/'+rid+'/review','PUT',{'rating':5,'body':'My own recipe'},a,400)
 assert request('/recipes/'+rid)['rating']==5
 request('/recipes/'+rid+'/groceries','POST',{'servings':4},b)
 request('/planner','POST',{'recipeId':rid,'day':'2026-10-05','meal':'Dinner','servings':4},b)
 request('/pantry','POST',{'name':'LEMON','quantity':'2','expiresOn':'2026-10-10'},b,201)
 request('/pantry','POST',{'name':'lemon','quantity':'3','expiresOn':None},b,201)
 k=request('/kitchen',token=b);assert len(k['pantry'])==1 and len(k['plans'])==1 and len(k['groceries'])==len(recipe['ingredients'])
 g=k['groceries'][0]
 request('/groceries/'+g['id'],'PATCH',{'checked':True},a,404)
 request('/groceries/'+g['id'],'PATCH',{'checked':True},b,204)
 request('/planner/'+k['plans'][0]['id'],'DELETE',token=a,expected=404)
 request('/creators/'+me['id']+'/follow','PUT',{},b)
 assert me['id'] in request('/library',token=b)['followingIds']
 request('/recipes/'+rid+'/report','POST',{'reason':'Integration test report for review'},b)
 request('/recipes/'+rid,'DELETE',token=b,expected=404)
 request('/collections/'+c['id'],'DELETE',token=b,expected=204)
 assert rid in request('/library',token=b)['savedIds']
 request('/recipes/'+rid,'DELETE',token=a,expected=204)
 assert len(request('/kitchen',token=b)['plans'])==0
 request('/recipes/'+rid,expected=404)
 request('/me','DELETE',{'password':'bad'},b,401)
 caps=request('/capabilities');assert caps['videoModel']=='doubao-seedance-2.5-eco'
 if not caps['textAI']:request('/ai/jobs','POST',{'kind':'recipe','prompt':'Make a nice pasta recipe'},a,503)
 print(f'PASS: {passed} API checks, including authentication, admin access, ownership, drafts, search, collections, reviews, planning, groceries, pantry, follows, and cascading deletes.')
finally:
 for token in accounts:
  request('/me','DELETE',{'password':password},token,204)
