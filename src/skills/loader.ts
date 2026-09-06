import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export interface Skill {name:string;description?:string;path:string;instructions:string;}
export async function loadSkills(dir:string, enabled?:string[]):Promise<Skill[]>{
  let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return [];}
  const out:Skill[]=[];
  for(const entry of entries){if(!entry.isDirectory()||(enabled&&!enabled.includes(entry.name)))continue;const path=resolve(dir,entry.name,'SKILL.md');try{const instructions=await readFile(path,'utf8');const first=instructions.split('\n').find(x=>x.trim()&&!x.startsWith('#'))?.trim();out.push({name:entry.name,description:first,path,instructions});}catch{}}
  return out;
}
