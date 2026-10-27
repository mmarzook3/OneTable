"""Execute the trusted metadata classifier with mocked GitHub APIs; no network."""
import json
from pathlib import Path
import subprocess
import unittest


class DocumentationStatusTests(unittest.TestCase):
    def workflow(self):
        try:
            import yaml
        except ImportError:
            self.skipTest('PyYAML unavailable')
        root = Path(__file__).resolve().parents[2]
        return yaml.safe_load((root / '.github/workflows/release-checks-docs.yml').read_text())

    def test_trusted_workflow_permissions_and_no_pr_execution(self):
        workflow = self.workflow()
        events = workflow.get('on', workflow.get(True))
        self.assertEqual(set(events), {'pull_request_target'})
        self.assertEqual(events['pull_request_target']['paths'], [
            'README.md', 'AGENTS.md', 'CHANGELOG.md', 'docs/**/*.md',
            'scripts/home-deploy/README.md', '.github/workflows/release-checks-docs.yml'])
        self.assertEqual(workflow['permissions'], {
            'contents': 'read', 'pull-requests': 'read', 'statuses': 'write'})
        self.assertTrue(workflow['concurrency']['cancel-in-progress'])
        self.assertIn('github.repository', workflow['concurrency']['group'])
        self.assertIn('pull_request.number', workflow['concurrency']['group'])
        steps = workflow['jobs']['documentation-status']['steps']
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]['uses'], 'actions/github-script@v7')
        self.assertNotIn('run', steps[0])
        script = steps[0]['with']['script']
        for forbidden in ('require(', 'import(', 'exec(', 'process.env', 'secrets.'):
            self.assertNotIn(forbidden, script)

    def test_docs_mixed_renames_incomplete_counts_and_head_races(self):
        script = self.workflow()['jobs']['documentation-status']['steps'][0]['with']['script']
        harness = '''
const gate = new (Object.getPrototypeOf(async function(){}).constructor)('context','github',SCRIPT);
async function check(names, expected, options={}) {
  const files = names.map(name=>typeof name==='string'?{filename:name}:name);
  const statuses=[];
  let reads=0;
  const sha='a'.repeat(40);
  const github={rest:{pulls:{
    get:async()=>({data:{head:{sha: (++reads===1?options.before:options.after)||sha},
      changed_files: options.count ?? files.length}}),listFiles(){}
  },repos:{createCommitStatus:async status=>statuses.push(status)}},
    paginate:async()=>{if(options.fail)throw Error('API failure');return files;}};
  try {await gate({repo:{owner:'owner',repo:'repo'},payload:{pull_request:{number:1,head:{sha}}}},github);}
  catch(error){if(options.fail && statuses.length===0)return;throw error;}
  if(statuses.length!==Number(expected))throw Error('Unexpected status for '+JSON.stringify(names));
  if(expected && (statuses[0].sha!==sha || statuses[0].context!=='release-checks' ||
                 statuses[0].state!=='success'))throw Error('Wrong status target');
}
(async()=>{
 await check(['README.md','AGENTS.md','CHANGELOG.md','docs/guide.md','docs/nested/guide.md','scripts/home-deploy/README.md'],true);
 await check([{filename:'docs/new.md',previous_filename:'docs/old.md'}],true);
 await check(['README.md','back/app/main.py'],false);
 await check([{filename:'docs/new.md',previous_filename:'back/app/main.py'}],false);
 await check([{filename:'back/app/main.py',previous_filename:'docs/old.md'}],false);
 for(const file of ['docs/script.py','front/README.md','config/scanaki-runtime-assets.json',
                   '.github/workflows/release-checks-docs.yml','docs/../app.md','docs\\\\escape.md'])
   await check([file],false);
 await check([],false);
 await check(['README.md'],false,{count:2});
 await check(Array(3000).fill('README.md'),false,{count:3001});
 await check(['README.md'],false,{before:'b'.repeat(40)});
 await check(['README.md'],false,{after:'b'.repeat(40)});
 await check(['README.md'],false,{fail:true});
})().catch(error=>{console.error(error);process.exit(1);});
'''.replace('SCRIPT', json.dumps(script))
        subprocess.run(['node', '-'], input=harness, text=True, check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
